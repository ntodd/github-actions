# The factory: design

Draft for review, 2026-11-11.

The factory takes an accepted issue through implementation, review and
integration until its work has landed on `main`. You decide what lands.
It runs on GitHub Actions, with Claude and project tests on ntodd/crew.
GitHub is the interface and holds the durable records; there is no
separate service or database to operate.

Issue generation is outside this system. A person, flake-hunt, a watcher
for broken `main`, or another producer can submit work through the same
admission contract. Once accepted, the issue follows the same lifecycle.
Deploying is also out of scope. Agent Merge, Agentic Workflows and an
external merge service are not dependencies.

The README grew one feature at a time. This document defines the whole
workflow first, from an issue being labeled to its PR merged with `main`
still green, so the code can be checked against it and the gaps fixed in
order. It also sets two requirements for everything that follows: you
can drive the factory from any GitHub client, and adding it to a repo
takes one small workflow file and a config file, with all the logic in
this repo.

## Why now

On 2026-11-11, five of the App's open PRs conflicted with their default
branch and none of them was moving:

| PR                               | Why it was stuck                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| next#293                         | Resolved cleanly, but `main` didn't compile, so the run blocked and threw the merge away. The reason went on the issue, so the PR showed only `agent-conflict`. |
| foreman#167                      | `main` already had the fix. The run asked for the PR to be closed, on the issue.                                                                                |
| streamhop#739                    | Its build crashed on 11-08. The crash set `agent-blocked`, and the sweep skips blocked issues, so nothing ever retried it.                                      |
| hugin#199, agent-ready-sandbox#3 | Stacked PRs, which resolve runs don't handle.                                                                                                                   |

And `next`'s `main` broke because #292 and #294 merged two minutes apart.
Each was green against the `main` it was tested on, and nothing retested
the second against the first.

Each of these has a local fix. The pattern behind them is that the
workflow ends at "Done" (PRs handed over for review). After that, only the
conflict sweep acts, nothing owns merging or `main`, and the state lives
in places you don't look.

## Goal

An accepted issue becomes reviewed, tested changes on `main`. Whenever
the factory needs you, it says why on the PR you're looking at, and you
can answer from any GitHub client. Waiting for CI, review or an answer
does not occupy a Crew runner.

## Rules that always hold

1. **Integration is tested before landing.** Required checks must pass
   against the current base. This cannot prevent every regression; when
   `main` is red, accepted repair work takes priority.
2. **Every agent PR is in exactly one state**, and the PR itself shows
   the state, why, and what happens next.
3. **Every wait says what ends it.** A question needs your answer; review
   needs your approval; CI needs a result. None holds a worker open.
4. **Nothing stalls silently.** A run that crashes, times out or is
   cancelled is retried automatically, within a budget. After that it
   becomes a question.
5. **Only trusted people's words are instructions.** Issues, comments,
   reviews and labels count only from `trusted-users` (and registered
   producers, below). Everything else, including anything the App wrote,
   is data.
6. **You decide what lands.** The App never merges, never pushes to
   `main` and never approves. Agent changes after approval remain subject
   to approval of the latest push. Auto-merge is not permission to land
   future, unreviewed fixes.
7. **Automation is level-triggered and bounded.** The reconciler reads
   the current state and decides. Duplicate events must not duplicate
   work or writes. Every admitted automatic attempt counts against a
   budget.
8. **Callers stay thin.** A repo's workflow file holds only what GitHub
   requires to live there. The logic is in this repo, and a repo's
   settings are in its config file.

## Constraints

- **No merge queue.** GitHub offers merge queues only on organization-owned
  public repos, or private repos in organizations on Enterprise Cloud. The
  repos are private and owned by a personal account. Auto-merge and
  rulesets (including "require branches to be up to date") are
  available.
- **The App** can write contents, PRs, issues and actions, and read checks
  and statuses. It has no workflows or administration permission, so it
  can't change `.github/workflows/` or the rulesets. The ruleset keeps it
  off `main` without your approval. Only trusted controller and publisher
  jobs hold its credentials. Claude gets read access, including during
  preparation for publishing.
- **`GITHUB_TOKEN` events don't start workflows**, except
  `workflow_dispatch` and `repository_dispatch`. Anything that has to
  start CI (pushing to a PR branch) uses the App's token.
- **Scheduled workflows run late.** The daily sweep, scheduled for 09:23
  UTC, has been running around 17:10 UTC. A schedule is a backstop,
  never the main trigger.
- **PR-event workflows run the PR's copy of the workflow**
  (`pull_request_review`, for one). They get a hop with no secrets (see
  Trust).
- **Factory jobs run on Crew.** Claude defaults to `crew-l`; controller and
  clean-update jobs use `crew-s`, and review wake-ups use `crew-xs`. Each job
  gets its own disposable VM. Controller and publisher jobs never execute
  project code. A worker's writable filesystem is
  discarded between jobs; credentials and caches are not shared with
  publisher jobs.
- **Some things have to be in the repo's own workflow file:** the
  triggers (`on:`), the workflows `workflow_run` listens to, the cron
  and the permissions ceiling. Everything else can be in a reusable
  workflow here. A job that its `if:` skips doesn't start a runner, so
  event filtering can be here too.

## Architecture

```
  people            producers            GitHub itself
  (comments,        (flake-hunt,         (pushes, CI results,
   labels,           main-red,            reviews, merges,
   reviews,          dep scans...)        mergeability)
   approvals)
      │                  │                    │
      ▼                  ▼                    ▼
  ┌──────────────────────────────────────────────────┐
  │ gate: who's asking, are they trusted, and what   │
  │ do they want (the router reads mentions)         │
  └──────────────────────────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────┐
  │ controller: read GitHub + durable records,      │
  │ reconcile each item, reserve the next operation │
  │ and dispatch it through Actions                 │
  └──────────────────────────────────────────────────┘
                         │
          ┌──────────────┼───────────────┐
          ▼              ▼               ▼
     workers         publisher        surfaces
     Claude + tests  validated Git    labels, PR status
     on Crew         and API writes   comment, check run
          │              ▲
          └── proposal ──┘
```

A **work item** is an accepted issue and its required PRs. A trusted
user's own PR, worked on request, is a work item with no issue. Its stable
key is the repository ID plus `issue:<number>` or `pr:<number>`. Branch
names, labels and the most recent labeling event do not change that key.

Each PR has its own lifecycle. The issue summarizes them and is complete
only when all required PRs have merged or you explicitly accept another
disposition. A merged lower level does not close a partly finished stack.
The controller records issue-to-PR membership when it accepts a publish
proposal; an agent-written `Fixes` line alone cannot add work to the item.

### Extension points

These are contracts, not a plugin framework. Each one gets built when
something needs it, and the first instance proves the contract.

| Extension point | What plugs in                                | Today                             | Next                                                  |
| --------------- | -------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| **Actions**     | A new action in the router's menu            | `/resolve`, `/effort`             | `@ntodd-agent` mentions and `/agent <action>` (below) |
| **Admission**   | An authorized issue from an upstream source | flake-hunt, hardcoded in the gate | One admission contract; producers remain separate    |
| **Signals**     | Something a PR must satisfy before hand-over | required CI, `review-bots`        | any check run by name, blocking or advisory           |
| **Modes**       | A kind of run                                | build, resolve                    | respond, update, retry                                |
| **Surfaces**    | Somewhere state is shown                     | issue status comment, labels      | PR status comment, check run, state JSON              |

## Durable state and operation ownership

GitHub's API is authoritative for issues, comments, reviews, branch heads,
checks and merges. A dedicated `factory-state` branch holds what GitHub
cannot infer: accepted requests, pauses, retry budgets and pending work.
It contains versioned JSON records, no executable code or secrets.

An initial mention can have a request-only item record while the router
interprets it. This stores acknowledgements and bounded routing attempts;
it does not authorize a worker or consume a coding attempt. Admission
requires a supported work action and a fresh check of its original trusted,
unedited source. Status, effort and stop requests cannot silently become
permission to build.

The layout is small: `items/<key>.json`, `operations/<id>.json`, and a
repository record for schema version and scheduling. An item records:

- its admission evidence and accepted issue revision
- its PRs, their dependencies and their individual states
- the IDs and revisions of comments and reviews already incorporated
- its current generation, active operation, pause or question
- automatic attempts and cost totals, and what it is waiting for

The repository record also identifies the factory App by ID and bot login,
verified during setup. Active controllers compare that identity with the
App authenticated by their credential. Read-only reports and workers use
the protected record. Changing the mention handle or review-bot list cannot
turn the factory's own output into instructions or review signals.

An operation records its mode, triggering evidence, generation, expected
head and base SHAs, pinned tooling/config versions, reserved branch names,
Actions run ID and attempt, result artifact and intended publish effects.
Its stages are `prepared`, `claimed`, `result-ready`, `publishing` and
`done`, with terminal `failed` or `superseded` outcomes. Each effect has a
receipt so a retry can finish a partial publish.

### One writer, short transactions

All state mutations, admissions and publishing jobs share the repository
concurrency group `factory-control`, with `cancel-in-progress: false`.
The group belongs to these short jobs, never to a whole workflow that
waits for Crew. No job holding it waits for another job in that group.

Read the state branch tip, write a commit whose parent is that tip, then
advance the ref with a fast-forward-only update. On rejection, reread and
reconcile; never overwrite a newer record. Reserve an operation in state
before dispatching it. Persist the exact proposed commit SHAs and API
effects before publishing them. GitHub state and the ledger cannot be
updated atomically, so recovery reads both.

The state branch has rules restricting updates to the factory App and
administrators, and blocking deletion and force pushes. `enable.sh`
verifies those restrictions. Workers have no write credentials. State
records coordinate authorized work; they never substitute for fresh
checks of the original user's authority. Missing or malformed state
pauses affected work for repair, rather than reconstructing permission
from labels or starting another build.

### Dispatch and recovery

Actions delivery is treated as at least once. There is no claim of
exactly-once dispatch or a durable FIFO queue in Actions concurrency.
Pending jobs can be replaced; the next pass scans durable unfinished
operations and unconsumed commands instead of relying on the last event.

1. The controller records one operation for the item's current generation
   and reserves its automatic-attempt budget. Redispatching that same
   operation does not reserve another attempt.
2. It dispatches the worker workflow on the default branch with the item
   and operation IDs. If dispatch times out, the operation stays prepared;
   a bounded redispatch uses the same ID.
3. A short admission job takes `factory-control`, rereads authorization,
   and claims the operation for its Actions `run_id` and `run_attempt`.
   It checks that the target PR is still open and its head still matches
   the reservation. Only one run can claim it. Duplicates exit before
   allocating Crew.
4. The Crew job uses `factory-item-<stable-key>` concurrency, without
   cancelling a running worker. It rechecks ownership before starting.
   An owner whose Crew job is queued still owns the operation.
5. The publisher validates the result against that recorded owner. A
   delayed artifact or a manually rerun workflow attempt cannot acquire
   ownership merely by naming the old operation.
6. Completion events and the scheduled pass recover unfinished work. A
   crashed admission, worker or publisher is reconciled from its Actions
   status and any completed effects before a new attempt is reserved.

An offline Crew runner is a queue problem, not a failed implementation.
Default deadlines are 30 minutes to start and two hours to execute an
attempt, configurable per repo. A deadline requests cancellation; the
controller confirms the owning run is terminal before assigning a new
worker. An unknown API result means wait and retry the read, not assume
that the owner died. Repeated dispatch or queue failures become a question.
Rechecking or redispatching the same reservation spends no additional coding budget; a
replacement attempt needs a new reservation.

`stop` persists the pause and advances the item generation before asking
Actions to cancel the worker. Every publisher checks that generation
under the controller lock. A result from an older generation cannot
authorize a new publish request.
Stop takes effect when acknowledged after the state write. A request sent
to GitHub before that point may still complete afterward, including after
the publisher crashed and released its Actions lock. Stop cannot retract
that request or undo an applied commit. Its acknowledgment lists unresolved
writes, and their outcomes are reconciled without resuming the item.
Restart also advances the generation and records each close operation
before admitting replacement work.

### Publishing after a crash

For a new PR, branch names are reserved from the item and operation IDs.
On recovery, find the existing branch and PR by their recorded identities
before creating anything. For an existing branch, the proposed commit
must extend the recorded head; if the remote head differs, inspect whether
it already contains the exact published commit. Otherwise mark the result
stale and reconcile. Never force-push to make an old result fit.

Every comment, review reply and label change has a stable effect ID and a
recorded target. After an ambiguous API response, inspect the target before
retrying. If the result cannot be established, wait or ask instead of
blindly posting another comment. Rendering a stale status can be repeated;
publishing code or closing a PR requires fresh preconditions.

Separate request submission, remote application and receipt persistence.
Record the proposed commit and intent before sending the request. After a
timeout or crash, observing the old head does not prove the request failed:
it may still be in flight. An applied exact commit can be recorded, and a
definitive rejection can be retried if authorization still holds. An unknown
outcome remains unresolved; do not replace the operation or send another
write on the assumption that nothing happened. Release the Actions job
while waiting, and escalate unresolved outcomes after a bounded deadline.
This may require human investigation rather than an automatic retry.

Issue and PR state changes are serialized by target, including across work
items. An uncertain close prevents a new reopen, even if the issue currently
looks open. A successful update response is a receipt. Recovery of a lost
response requires a matching state event by the factory App, newer than the
complete event history observed before submission and the recorded request
time. A human's state change or an old App event cannot establish that a
request finished. The event can establish a historical outcome even if a
person changed the state again afterward; that later state still needs a
fresh decision. This relies on complete, authoritative event observations
and the factory being the sole holder of its state-changing App requests.
Missing evidence remains unknown and escalates; it does not authorize a
second request.

The publish deadline defaults to 15 minutes. An overdue uncertain request
raises a question bound to that operation, effect and request. Recovery
continues reading its outcome. Only a verified applied effect or definitive
rejection clears this particular question; an answer alone cannot make an
unknown request safe to repeat. That observation grants no new permission,
does not resume a stopped item and cannot clear an unrelated human decision.
Known rejections have bounded request counts and backoff. Exhausting those
limits asks you before further work; applied receipts remain recorded.

The publisher checks the recorded base before authorizing a proposal, and
the branch update must enforce the expected PR head at the write itself.
The Git adapter uses an explicit expected-old lease for this comparison,
after independently proving that the proposal extends the recorded head.
Git names that option `--force-with-lease`; this combination still rejects
history rewrites and a changed remote head. The state branch uses the
API's fast-forward-only update instead.
There is no atomic transaction spanning main, the PR branch and the state
branch. Main may advance after the check or while a write is in flight;
the proposed commit can still reach the PR branch. Its recorded integrated
base remains unchanged, so strict CI/merge checks block landing it until
it is updated and tested again. A PR can also merge or close while its
branch write is in flight. Record the commit that actually merged and
report any later branch write; never treat a post-merge push as landed work.

## Worker contract and releasing Crew

A worker receives the accepted issue revision, new trusted feedback,
operation ID, expected commits, mode, budgets and pinned tooling/config.
It checks out those commits and runs Claude and project tests on Crew.
It returns a proposal: commits, test evidence, requested PR/comment
changes, and one of `ready`, `needs-you`, `no-change` or `failed`.

The worker has a read-only GitHub token. It cannot publish, update the
ledger, approve, merge or start other workflows. The current Claude
publish phase becomes preparation of structured output. A separate clean
publisher job uses the App token to apply only validated effects to the
recorded branches and PRs. It never runs scripts, hooks or configuration
from the worker's checkout or artifact. Git objects and text are data;
validate paths, sizes, commit ancestry, targets and forbidden workflow
changes before writing. App permissions remain an additional boundary.

The result is an Actions artifact bound to the claimed run ID, attempt
and operation. The controller checks provenance and schema, but treats
its contents as untrusted proposals. It does not accept a worker's claim
that a command is authorized or that required CI passed. External checks
and approval are reread from GitHub for the actual commits.

The worker ends after uploading its result artifact, before the publisher
runs. Only a controller job validates that artifact and advances the
operation to `result-ready`; upload alone does not change the ledger.
The worker workflow ends after upload. A separate controller run confirms
it is terminal before accepting the result; the publisher is not a job
inside a worker workflow whose completion it must await. An artifact uploaded before a crash can still be accepted if its
provenance matches the recorded owner. After publishing, the item waits on
CI, review bots, human review or a dependency, and the next event wakes the
controller.
The controller either hands over, asks a question, or admits a new respond
operation. `max-rounds` applies across those operations, not per job.
Timeouts on awaited signals are stored deadlines checked by subsequent
passes, not sleeping runners.

A fresh session reconstructed from the issue, PRs, feedback and recorded
outcomes is the correctness path. Restoring Claude's session is optional:
use only a compatible artifact from the recorded run, with a stable
workspace layout and validated metadata. Exclude credentials and broad
home-directory snapshots. Expired, missing or incompatible session data
starts a fresh session on the same PRs; it does not start a fresh build.
GitHub branches preserve published code. Unpublished work needs a valid
result artifact or must be recomputed within budget. Artifacts and caches
are never the durable source of ownership or approval.

## Adding it to a repo

It takes one thin caller, one config file and one setup script run. The
state branch is initialized by setup, not committed to the default branch.

An existing GitHub-held App key can be inspected through an owner-only manual
request `{"kind":"inspect"}` after the reviewed read-only caller/config is
installed. This reads App and installation metadata in the clean job without
creating an installation token or accessing the ledger. Bootstrap pins the
shared commit and records the App ID as an unverified candidate. Administrator
setup must verify the report's workflow/artifact provenance before using its
public metadata as App identity; a downloaded JSON file alone is insufficient.

The caller, `.github/workflows/factory.yml`, declares GitHub's required
triggers and permission ceilings. It routes two kinds of job:

| Entry | Events | Credentials and behavior |
| ----- | ------ | ------------------------ |
| Wake-up | PR reviews and review comments | No secrets; a small shared job dispatches a controller pass on the default branch with a target hint only |
| Controller or worker request | Issue labels/comments, PR metadata, main pushes, completed runs, schedule, dispatch | Trusted entry on the default branch; shared code rereads authority before admitting work |

Use `pull_request_target` only for PR metadata events such as close,
reopen, synchronize and ready-for-review. Never check out or execute its
PR head. Review events use the unprivileged hop above. Fork dispatch
limitations do not widen permissions: unsupported fork work is not admitted,
and the backstop still inspects supported items.

`workflow_run` listens to the repo's CI names and `factory` so interrupted
worker runs are noticed. Filter factory completions to runs with recorded
operations; completion of an ordinary controller pass must not trigger
another pass indefinitely. `check_run`, `status` and review wake-ups cover
external signals where GitHub emits the event; the backstop covers missing
events. A schedule of `17 * * * *` is the initial backstop, not a latency
promise. `workflow_dispatch` takes one JSON `request` with a target and,
for internal operations, an operation ID. Payloads grant no authority.

The caller has separate `uses:` jobs for the unprivileged hop and trusted
entry, with explicit secrets only on the trusted entry. No trust logic,
inline shell, polling or run-name parsing lives in the caller. Reusable
jobs narrow permissions further. Worker jobs get read permissions and
model credentials; only clean controller/publisher jobs can mint App write
tokens. The reviewed default-branch caller and shared workflow are part of
the trust boundary, and their refs are verified before privileged work.

The config, `.github/factory.yml`:

```yaml
trusted-users: [ntodd]
handle: ntodd-agent
runner: crew-l
effort: medium
max-rounds: 3
review-bots: []
signals:
  - check: dependency-review
    blocking: false
producers: [flake-hunt, main-red]
budget:
  automatic-attempts-per-item-per-day: 3
  repeated-failure-limit: 2
timeouts:
  queued-minutes: 30
  worker-minutes: 120
  publish-minutes: 15
environment:
  values:
    MIX_ENV: test
setup: |
  docker compose up -d postgres
```

Config is read from the default branch, never from a PR. Its SHA and the
shared tooling SHA are recorded for each operation. Setup runs only on
Crew. Secrets remain repository secrets, explicitly passed to the jobs
that need them. The caller can follow the shared workflow's `main`, as
today, but in-flight operations retain their recorded tooling version.

`environment.values` supplies literal strings to project setup and the
Claude/test process. Declare secret names separately:

```yaml
environment:
  values:
    MIX_ENV: test
  setup-secrets: [PACKAGE_READ_TOKEN]
  worker-secrets: [DATABASE_PASSWORD]
```

Store those values in the repository's `SETUP_SECRETS` secret, as literal
`NAME=value` lines or a JSON object of string values. JSON supports multiline
values. Only declared names are selected, from the operation's pinned
default-branch config; a PR cannot add names. Duplicate names, reserved runtime
or credential variables, missing names and invalid values fail preparation
with a concrete question, before any model invocation. Supplied bundles are
also checked by the setup CLI; existing repository secret contents can only
be validated on Crew.

Select and mask the values before project checkout. Retain only the selected
names in a private file outside the checkout, bound to the operation, config
commit and owning run attempt. Read it after a fresh ownership check, pass
each phase its declared child environment, and remove it when the job ends.
The factory does not put these values in job outputs, the ledger or result
artifacts. Both phases share the Crew job and filesystem; every selected
secret must be suitable for project code in that job. App keys, attachment
credentials and GitHub write tokens stay in the clean jobs.

Setup can use `GITHUB_PATH` for installed tools. Other variables needed by
tests belong in `environment`; ambient project variables from setup do not
expand the worker's allowlist. Setup failures return an artifact without code
effects and use the ordinary bounded retry/question path.

`enable.sh` checks the App installation, opens the caller/config PR,
sets secrets and `AGENT_APP_ID`, creates labels and the state branch,
installs the state protections and main approval/check rulesets, and
turns on the repo's auto-merge setting. It verifies the resulting rules
and reports failure rather than claiming an unprotected repo is enabled.

The repo's CI must run on `pull_request` and pushes to its default branch,
with required checks named in the strict ruleset. The factory reads the
results and does not prescribe the CI implementation. `main` in this
document means the configured default branch, not a hardcoded branch name.

## Talking to the agent

Every client can comment, so comments are how you talk to the agent.
Mention it anywhere in a comment on an issue, a PR or a review thread,
and say what you want in your own words:

```
@ntodd-agent rebase this
@ntodd-agent go with 1
@ntodd-agent the test is wrong, not the code. Fix the fixture instead.
@ntodd-agent stop
```

The handle is the configured mention name (`handle` in the config).
Ordinary comments are context; a mention or exact command starts work.
You can talk across several comments and mention the agent in the last one.

**The router** reads each mention and picks one action from a fixed menu:

| Action  | Does                                                             | Claude on Crew    |
| ------- | ---------------------------------------------------------------- | ----------------- |
| answer  | Resume what's waiting on you, with your comments as the answer   | the waiting mode  |
| respond | Work on the PR's CI and review now, including what you just said | yes               |
| resolve | Merge `main` in and resolve the conflicts                        | yes               |
| update  | Bring the branch up to date with `main`                          | no                |
| build   | Start work on an issue that has no open PRs                      | yes               |
| restart | Close the issue's open PRs and build again from scratch          | yes               |
| retry   | Rerun the mode that failed                                       | (the failed mode) |
| stop    | Persist a pause, invalidate old results and cancel the worker | no |
| effort  | Change the effort for the next runs                              | no                |
| status  | Reply with the state, why, and what's next                       | no                |
| clarify | It isn't sure: reply with what it understood, and ask            | no                |

- The router is a small, fast model on GitHub's runners, with structured
  output limited to this menu. It decides which action runs, and your
  words go to that run as its instructions. However the comment is
  worded, the controller accepts only a validated action from that menu.
  The publisher never merges, approves or pushes to `main`.
- It says what it understood before anything long runs: 👀 on your
  comment right away, then a one-line reply ("Merging main into this
  branch. It conflicts in `navbar.ex`, so a resolve run is starting.").
  If it got you wrong, `@ntodd-agent stop`.
- "Rebase" means bring it up to date. The factory merges `main` in
  instead of rebasing, so nothing is force-pushed and the review history
  stays, and the reply says it merged: update when the branch is only
  behind, resolve when it conflicts.
- A mention inside a review thread is about that thread, and the respond
  run starts from it.
- For a routed answer, record the trusted mention handle and keep the
  original text. The controller recognizes short replies such as
  `@ntodd-agent go with 1` against its recorded question; normalizing that
  reply cannot select another PR or waive a different issue revision.

**Exact commands** skip the router, for scripts and your own app:
`/agent <action> [text]`, with the actions above. `/resolve` and
`/effort <level>` stay as aliases. They're deterministic and cost no
model call.

**Labels** are shortcuts for the two things you do most: `agent-ready`
means build (or answer, when it's waiting on you), and `effort:<level>`
sets the effort.

From the `gh` CLI or your own app, post a comment:
`gh pr comment 293 -b "@ntodd-agent rebase this"`. The REST API takes the
same comment, so there's no second path to keep in sync.
`workflow_dispatch` stays an internal hop: the factory's own jobs use it,
and a run started that way re-reads everything and trusts nothing in its
inputs.

A mention or command counts when the router or a run reads it from the
API, not from the event payload. The author has to be trusted, and the
comment unedited since it was posted.
Same-second commands from one source kind follow their numeric database
IDs. When different source kinds have indistinguishable timestamps, stop
takes precedence rather than guessing that an older request should resume
work.

### What a run reads

Every run reads all of your comments on the work item, not only the one
that started it:

- every comment of yours on the issue, and on each of its PRs'
  Conversation tabs
- every comment in each review thread, not just the first
- the text of your reviews

Comments since the last question or hand-over are marked as new, so the
run treats them as the answer and the rest as history. Before each
phase, it checks for new comments from you and passes them in, so a
correction you post mid-run lands at the next step.

Today a run reads only the issue's comments, once at the start, and
only the first comment of each review thread
(`agent-ready/lib/github.mjs:216`).

## Admission: an issue is the input

A person or an upstream producer supplies the issue. Admission checks
who authorized it, what revision was accepted, and which issue owns the
work. It creates the same work-item record regardless of source.

- Human issues require a trusted author, trusted edits and a trusted
  labeling event or explicit command. Reread the timeline and content
  through the API before admitting and publishing work.
- A producer issue must come from `github-actions[bot]`, name an allowed
  source in `<!-- agent-ready:source=<name> key=<dedupe-key> -->`, and have
  no untrusted editors. The marker alone is not authentication. The
  workflows able to write as that bot are part of the repository's trust
  boundary. flake-hunt's existing marker remains a compatibility alias.
- Source, evidence and deduplication key describe where the issue came
  from. Producer logs and diagnoses are data, not instructions. Any
  playbook or priority policy comes from reviewed default-branch config.
- Producers may request a controller pass after filing an issue. They
  never dispatch a coding worker directly. Bot labels may not emit a
  workflow event, so the scheduled pass also scans for eligible issues.
- Grouped issues must each pass admission. Their accepted membership is
  recorded; generated PR text cannot expand that authorization later.

Finding flakes, grouping their causes, detecting broken main, and
suppressing duplicate reports belong to producers. This design specifies
only admission and handling of the resulting work. A main repair issue
uses this same path, with priority assigned by trusted policy.

A registered `main-red` issue uses the failing default-branch commit SHA
as its source key. A trusted human can instead end an admitted issue with
`<!-- factory:repair-base=<sha> -->`. The controller verifies that base's
ancestry and CI evidence before registering its diagnostic signatures.
Other producer keys remain opaque deduplication keys; naming a producer
does not make its diagnoses instructions or prove a failure is current.

## Signals: what a PR must satisfy

A PR is handed over when every **blocking** signal passes. Signals are
configured per repo:

- **Required checks:** read from the ruleset, so the agent waits for the
  same checks GitHub requires for merging.
- **Review bots:** today's `review-bots`. Each one must have reviewed the
  head commit (or time out), and its threads get a reply.
- **Named check runs:** any check by name, such as a dependency review or
  a CodeQL scan, marked `blocking` or `advisory`. An advisory signal's
  findings are answered but not waited on.

A new reviewer bot or scanner goes in this list. The respond mode treats
every signal the same way: fix it, refute it with evidence, or ask you.
A bot's comment is never an instruction, and never starts a run on its
own.

## Modes

A mode describes an operation, not a workflow that stays alive until the
whole issue is finished.

| Mode | Execution | Result |
| ---- | --------- | ------ |
| **build** | Claude and tests on Crew | Proposed commits and PRs, or a question |
| **respond** | Claude and tests on Crew | Proposed fixes and replies for new feedback or failures |
| **resolve** | Claude and tests on Crew | Proposed merge with conflict resolutions and test evidence |
| **update** | Trusted job, no Claude | A clean merge of the recorded base into the recorded PR head; conflict becomes resolve |
| **retry** | Controller | A new bounded attempt after inspecting the previous attempt's effects |
| **close-out** | Controller | Final PR status and, only when all required work is accounted for, issue completion |

Update uses the same publish preconditions and receipts as a worker
proposal. It can fetch Git objects in a clean job, but never runs project
code. New tests run in CI after the App pushes. Only the controller and
publisher mutate remote state; workers propose changes.

## The reconciler

The reconciler is the controller's decision function: observed GitHub
facts plus durable state produce a bounded list of intended effects.
It runs as a short Actions job. It never checks out project code.

Events are wake-ups, not commands to repeat a previous decision. Each
pass scans unfinished operations, supported active items and new admission
requests, and rereads the relevant GitHub facts. Persist new trusted
commands by source ID and revision before acting on them. Coalescing an
event must not lose a command from another item. Keep explicit consumed
IDs; a timestamp alone can skip late-visible comments.
Late-visible work from before a recorded stop cannot resume the item. An
older stop or restart discovered after newer explicit work was admitted
does not revoke that newer intent.

Process new commands first. `stop` invalidates the current generation;
`status` and `effort` do not resume a stopped item. A work command, answer
or trusted relabel explicitly resumes it. Feedback received during a run
is recorded for the next phase or operation. It is marked incorporated
after successful publication, including a completed response with no code
change. Collecting an artifact alone does not account for a reply that was
never posted. An accepted issue edit
changes its revision and invalidates a proposal built against the old
revision; untrusted edits stop admission rather than becoming instructions.
After an old operation is recovered or superseded, an accepted edit starts
a respond operation on the existing PR. A clean branch update alone does
not account for changed issue requirements.

If every recorded PR has already finished when the issue changes, ask
whether those PRs cover the revised issue. `/agent answer accept-completion`
records that decision from a fresh trusted comment; `/agent restart` requests
replacement work. A numbered answer applies only to the recorded completion
question. An unclear answer is consumed once and gets a clarification, so
the same comment cannot generate a new question on every pass.

**Repository facts first:** determine current default-branch CI by SHA,
record dependencies on known main failures, and prioritize admitted repair
issues. A successful old run does not make the new head green. The
controller does not generate repair issues; without an admitted repair,
it reports that dependency and asks for one.

**Then each item, first applicable action wins:**

| What it sees | What it does |
| ------------ | ------------ |
| A PR merged or closed | Record that PR's outcome; complete the item only if every required PR is accounted for |
| An unfinished publish or an available result | Recover effects or validate the result before considering another worker |
| Stopped, or waiting on an unanswered question | Render status; no new work |
| A claimed operation whose owner is queued or running | No second worker; check its deadline |
| A prepared operation | Bounded dispatch or redispatch of that same operation |
| A terminal owner without a completed operation | Inspect results and effects; retry within budget, otherwise ask |
| A required PR closed without merging | Ask whether to replace it or accept its closure; do not silently finish the issue |
| Unsupported stack work | Ask with the affected PRs listed |
| A PR conflicts with its base | Resolve, unless its failures/dependencies already require waiting |
| CI is pending or mergeability is unknown | Wait for another observation; do not treat unknown as clean or conflicting |
| A PR has only a confirmed shared main failure | Wait on the repair issue; do not create another copy of the fix |
| A PR has other failing checks | Bounded rerun for an identified transient failure, otherwise respond |
| New trusted review feedback | Respond once for that feedback revision; do not replay an old changes-requested review forever |
| An auto-merge PR is behind its base | Select it for update under the merge policy |
| An accepted issue has no PR or active operation | Build in priority order |
| Blocking signals passed and feedback is handled | Hand over, showing any approval still required |
| Anything else | Render the current reason and next wake-up |

Terminal observations update records even while paused. They do not
resume paused work. A close-out pass records every PR's current outcome,
so a merged lower PR cannot continually hide unfinished upper PRs.

**Budgets:** defaults are three admitted automatic coding attempts per
item per UTC day, and escalation after the same normalized failure twice
without progress. `max-rounds` caps the respond loop across job boundaries.
Store failures with input SHAs and evidence; repeated event delivery is
not another failure. API updates, CI reruns and dispatch retries have
separate bounded counters and backoff. Explicit commands can authorize a
new attempt beyond the automatic quota, but each attempt still has turn,
time and round limits. Track actual model cost and Crew minutes by item;
tune limits using those measurements.

Keep each measurement's source and coverage explicit. Worker reports retain
the CLI version, reporting scope, per-phase turns and reported dollars.
Claude's cost field is a [client-side estimate](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
not an invoice; resumed totals must not be added as independent charges.
Mention routing records provider token usage even for refused or invalid
answers. Missing prices, interrupted responses and unusable artifacts remain
unknown, never zero. Actual invoiced dollars require separate billing evidence.
Likewise, completed Actions job timestamps measure Crew execution, excluding
queue time; they do not establish Crew's bill or VM boot time.

Bind usage to the recorded operation/run attempt or routing request. Retain
costs through stop, replacement and UTC rollover, and derive totals without
incrementing them on repeated collection. A bounded historical scan recovers
missing terminal-job measurements with durable backoff. Measurements and
their absence cannot authorize work, reset attempt budgets or discard code.
Status comments expose known totals and missing coverage separately.

Every external wait records its target, reason and deadline. The hourly
pass discovers missed completion events, overdue waits and cancelled jobs.
There is no promise of recovery within an hour: Actions schedules can be
late. A trusted `/agent status` or `/agent retry` wakes the same controller
from any client without needing a separate administrative path.

## States, and where you see them

One state per PR, rendered from its record and current GitHub facts. The
issue has a summary label plus counts and reasons for its PRs; it does not
copy one label blindly onto every PR. For example, a stack may show one
merged PR, one in review and one waiting on the lower level.

The issue's summary prefers an explicit pause, then a question or exhausted
failure, active work, queued work, an external wait, and finally review.
Its comment always lists mixed states so the summary cannot hide a blocker.
Completed PRs retain their own final state. The item is complete only when
all required outcomes are recorded.

| Label             | Means                                                                          | Leaves it when                    |
| ----------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `agent-ready`     | Queued                                                                         | a run starts                      |
| `agent-working`   | A claimed operation has it                                                                   | the run ends                      |
| `agent-review`    | Handed over, waiting for your review and auto-merge (replaces `agent-done`)    | merged, or work is needed again   |
| `agent-waiting`   | Waiting on something outside the PR, like a red `main`, and resumes on its own | the thing it waits on clears      |
| `agent-needs-you` | A decision or investigation needs you | you answer or give a work command; a verified outcome can settle a request-specific recovery question |
| `agent-failed`    | The last run died, and the retries ran out                                     | you request work, or relabel |
| `agent-stopped`   | You said stop                                                                  | you request work, or relabel |
| `agent-covered`   | Accepted work is covered by another recorded PR | close-out when that PR merges |
| `agent-complete`  | All required work has landed or an alternative was explicitly accepted | new authorized work |

Merged/closed PRs also display GitHub's terminal state. A closed required
PR without accepted replacement or waiver leaves the issue needing you.
Do not add issue-closing keywords to partial PRs: the controller closes
the issue after checking the full set. If a person or GitHub closes an
issue early, ask whether to stop or continue; do not silently override it.

`agent-blocked` splits into `agent-needs-you` and `agent-failed`, and
`agent-conflict` goes away, since GitHub already shows conflicts and a
resolve that needs you is `agent-needs-you`.

**Surfaces:**

- **PR status comment:** one comment per PR, edited in place, that says
  the state, why, and what happens next ("Waiting on main: #301 fixes
  the compile error. A resolve runs when main is green."). It ends with
  a hidden block of state as JSON for your own tools:
  `<!-- agent-ready:state {"state":"waiting","reason":"…","next":"…","run":"…"} -->`.
- **Issue status comment:** as today, the run's progress, edited in
  place.
- **Check run** (later; the App needs `checks: write`): an `agent-ready`
  check on each PR's head with the state as its title and the details as
  its summary. Every client shows checks, and the API returns them.
- **Notifications:** only for things that need you. A new
  `agent-needs-you` gets a new comment (which notifies you) and a review
  request. Everything else is edited in place.

Labels, comments and check runs are projections, not ownership records or
proof of authorization. The controller may read them to repair a surface
or recover a publish receipt. It never trusts their prose as instructions.
Controller API effects are recorded on the work item with their targets,
request identities and receipts. Status edits and factory-label repairs
can converge again after later changes, within a daily request budget.
Sent API effects that remain unknown or rejected past their deadline raise
an attention notice with the exact request identity. This does not discard
valid code or authorize another worker. A known outcome settles that notice
in place. Notification failures do not recursively generate notifications.
An uncertain comment creation or issue closure is inspected, not resent on
an absent result. A missing status comment can be replaced only after its
previous successful creation and subsequent deletion are established.
Who authorized a label comes from GitHub's timeline; coordination comes
from the state branch. A failed status edit cannot roll back published
code or cause another build.

## Main failures and integration

Required checks must pass with the PR up to date before GitHub can merge
it. A strict check ruleset has no bypass, including admins. The separate
approval ruleset keeps its existing admin exemption. This protects against
the two-individually-green-PRs problem; it cannot guarantee that tests
cover every regression or that dependencies never drift.

A red default branch is a repository dependency. Its repair issue comes
from a person or an upstream watcher, through normal admission. The
controller prioritizes accepted repair work and links affected PRs to it.
Ordinary builds do not carry a second copy of that repair. If no repair
issue exists, show that fact and ask; do not leave an unexplained wait.

Classify failures using the exact base/head SHAs, check identity and a
normalized failure signature: failing test or compiler diagnostic, not
just the job's name. Reproduction on the recorded base is stronger evidence
than similar logs. A PR can have both a shared main failure and a new
failure; only the shared one is deferred. Unknown attribution is reported
as unknown, with a bounded diagnostic attempt or a question. New runs for
an old SHA cannot supersede results for the current head.

For Actions, bind each diagnostic to the check, job, run attempt and tested
commit, then read every failed step within a small request/size budget.
Signed log downloads receive no GitHub credentials. Parse complete failure
reports and reobserve the checks before accepting the snapshot. Generic
exit messages, a matching job name, omitted diagnostics or a changed check
do not establish shared failure. The initial adapters recognize ExUnit,
Elixir and TypeScript output and specific check annotations; other reports
remain unknown rather than being matched by their title.

Repair registration retains verified signatures for the declared base and
accepted issue revision. A later main commit can depend on that repair only
for matching recorded diagnostics. Closing the repair issue cannot make
main healthy. A missing repair or unknown attribution asks on the affected
PR; a newly admitted matching repair, changed commits or verified green
current-main CI can settle that particular dependency question. An overdue
repair remains a question while the same dependency is unchanged. These
observations cannot clear an unrelated human decision or resume a pause.
Workers receive bounded diagnostic snapshots tied to their reserved commits;
those snapshots never substitute for GitHub CI or approval.

A resolve may publish its merge when its only remaining failures are
confirmed to match the recorded base. It then waits on the repair issue.
That exception never marks required checks successful or permits a merge.
Recovery of main is established by current-head required CI, not by a
repair issue being closed or by one previously red job passing.

## Merging and approval

You approve a PR and enable auto-merge, from any client. GitHub owns the
merge decision. The factory updates branches and repairs failures, but
never approves, enables auto-merge on your behalf, or calls merge.

Keep `require_last_push_approval`. When an agent pushes a fix or conflict
resolution after your approval, the PR must satisfy approval requirements
again. A clean base update may also require reapproval. The status comment
says so and requests your review once for the new head. Do not drop this
setting to make automation more convenient: auto-merge could otherwise
land later changes you never reviewed, even without the App calling merge.

When main moves, select one behind auto-merge PR for an update at a time.
Store that selection in repository state. Wait for its new checks, then
allow it to merge or report its blocker before updating another. If it
needs human input or misses its recorded CI deadline, release the selection
so other eligible PRs can progress. Use stable priority and age ordering.
This avoids updating every branch after every merge. It is deliberately a
small serial integration policy, with no speculative builds or throughput
promise equivalent to a merge queue.

If main moves during an update, strict checks still prevent landing an
outdated integration. Reconcile against the new base. PRs without auto-merge
are not automatically refreshed just for being behind; you can request
`/agent update`. The strict ruleset blocks an outdated merge, but does not
itself update the branch. Conflict resolution remains available separately.

The sandbox must exercise approval, clean update, conflict resolution and
CI repair with auto-merge enabled. Record GitHub's actual approval behavior
for each case. The acceptance condition is that no agent-written change
lands on approval of an earlier push. Extra approval is acceptable.

## The review loop

After hand-over, a trusted review drives the next round:

- A review with changes requested, or with open threads, starts a
  respond run on that PR. It fixes, replies and resolves threads the way
  rounds do now, then hands over again.
- An approval doesn't start a run.
- Review-bot comments are signal data, never commands. Their arrival can
  wake the controller; only the configured signal policy can authorize a
  bounded respond operation.
- A review's ID, revision and affected head are recorded. An old review
  still marked changes-requested blocks merging until the reviewer acts,
  but does not repeatedly start respond after its feedback is handled.

An operation records the review threads it may answer. Its worker proposes
reply text and whether to resolve each one; the controller accepts those
proposals only against a fresh snapshot with the original trusted or
configured signal anchors still present. A correction read during a phase
can update that snapshot without expanding the assigned thread set. New
threads wait for the next operation.

Code publishes before the replies that describe it. Each reply has an
effect marker, and its receipt precedes resolution. A reply sent before a
crash is recovered by its exact App marker. The publisher excludes its own
reply from the discussion fingerprint when validating resolution; new
discussion from anyone else leaves the thread open for another response.
An omitted assigned thread is not marked handled. A stopped publication
can record already-applied effects while abandoning its unsubmitted ones.

## Answering questions

When a run needs you, it ends with `agent-needs-you` and asks on the PR
(or on the issue, for a build that has no PR yet). When it has choices,
it numbers them, so an answer from a phone can be short:

> **Needs you:** `main` doesn't compile (#292 calls
> `VideoPasswordGate.session_key/0`, which #294 removed), so #293 can't
> go green.
>
> 1. Fix `main` in its own PR, then resolve #293 on top of it.
> 2. Stop work on #293 while I repair `main` myself.

You answer by mentioning the agent: `@ntodd-agent 1`, or in your own
words. Write as many comments as you like first; the mention is what
starts it. The controller resumes the mode that asked, on the same PRs, with
every new trusted comment since the question as the answer.

A required PR closed without merging needs an explicit disposition. Reply
with `/agent answer accept-closure #123` to accept that PR's closure, or
`/agent restart` to retire the recorded PRs and request replacement work.
The numbered answer `1` accepts only the PR named in the current closure
question, for the same accepted issue revision. The decision is recorded
with its trusted comment identity and does not waive any other required
PR. Reopening the PR clears that waiver; its earlier decision stays in
history, and closing it again needs a new disposition.

If the issue closes before all required work finishes, the factory asks
whether to stop or continue. `/agent answer continue` (or `1` for that
question) records a reopen request and continues the existing PRs after
its outcome is known. `/agent stop`, or `2` for that question, keeps work
paused. These answers bind to the question's accepted issue revision.
Continuing does not reset budgets, retire PRs or authorize a replacement
build. A later stop prevents new requests and cancels obsolete workers,
while recovery still records an already-sent reopening. If a person closes
the issue again after that reopening, ask again instead of reopening it
repeatedly. If all required work finishes first, record completion without
reopening the issue.

Relabeling an issue that has open PRs continues those PRs too. Starting
over is a restart (`@ntodd-agent start over`), which closes them first.
Restart records its intent and invalidates the older worker generation.
Recover or cancel that owner and any publication before recording the PR
close requests. A closed issue is explicitly reopened as part of the
request. Every old PR's outcome and every sent request must be known before
retiring its membership and admitting one replacement build. Old PRs and
their receipts stay in history; the item's automatic daily budget survives.
Stop prevents further close requests, and any uncertain request stays
attached to the restart until its outcome can be established.
(Today a relabel starts a fresh build, and the old PRs can't be resolved
any more, because the gate only accepts PRs opened after the latest
label.)

## Your own PRs

The App touches a PR you wrote only when you ask: `/agent resolve` or
`/agent update` on it. The status comment and labels go on the PR, since
there's no issue. It doesn't answer your review threads, change the
draft state or request reviews. Only the requested operation and its bounded recovery are authorized;
completion does not enroll your PR in ongoing automatic maintenance.

## Stacks (represented now, automated later)

- A stack is one work item with several PR records and explicit base
  dependencies. Its levels merge bottom first. Each level has its own
  checks, review and final outcome.
- Resolve and update work from the bottom up. Merge main into the bottom
  level, then that level into the one above it. Never force-push. Record
  each level's expected head and base; a partial result is recoverable.
- Only the bottom level is eligible for integration. After it lands,
  reread GitHub's actual base for the next level and validate or explicitly
  update it. Do not assume retargeting or deleted branches did the right
  thing. Auto-merge on each next level remains your decision.
- Merging the bottom level does not complete the issue. Membership and
  accepted alternatives, not `Fixes` strings, determine completion.
- Until stack automation is implemented, builds produce one PR per issue
  by default. Existing stacks remain visible and unsupported operations
  ask you explicitly. Do not keep generating work the controller cannot
  maintain.

## Trust and execution boundaries

- **Mentions and commands:** reread from the API. Authors must be trusted;
  edited command comments are rejected. Read all relevant comments, but
  only authenticated trusted content can change intent. New commands get
  stable source IDs and are checked again before their effects publish.
- **Reviews:** the PR-context hop gets no secrets or project checkout. It
  requests a default-branch controller pass. That pass rereads review
  author, content, current head and work-item eligibility. A dispatched
  target is a hint, never authority.
- **Producers:** validate the admission evidence described above. Logs,
  diagnoses and generated text remain data. A worker cannot authorize its
  own next task by proposing an issue or label.
- **Dispatches:** verify the default-branch entry, allowed sender and
  recorded operation. An arbitrary operation ID, artifact name or rerun
  is insufficient. Check the claimed run ID and attempt on every result.
- **Credentials:** App keys, attachment tokens and GitHub write tokens
  exist only in clean trusted jobs. Workers get model credentials and
  minimal read access. Removing a key from a worker's environment is not
  sufficient if another process on the same writable host retains it.
- **Artifacts:** validate the originating workflow, run, attempt, item and
  schema before reading a result. Do not execute its contents or use a PR
  checkout as controller code. Provenance identifies a proposal; it does
  not make the proposal trustworthy.
- **State:** only controller jobs mutate the ledger. Recheck authority
  against GitHub before effecting a decision; recorded agent text cannot
  grant permissions. State branch protections and workflow permissions
  are verified in the sandbox before rollout.
  The recorded App identity cannot silently change during normal setup or
  reconciliation. A missing identity requires setup; a different identity
  requires an explicit migration before work can resume.

## Failure scenarios and acceptance tests

The controller's decision function should run against saved GitHub/state
snapshots without a runner or model. Add a fake executor that can fail
before or after each side effect. Test the following cases first:

| Scenario | Required result |
| -------- | --------------- |
| Duplicate issue event or dispatch | One accepted operation and one claimed worker |
| Dispatch succeeds but its response is lost | Redispatch the same operation; only one run claims it |
| A queued controller job is replaced | Next pass rediscovers all unconsumed commands and unfinished operations |
| Crew is offline or the job times out | Report queue/worker failure; confirm terminal owner before retry |
| Worker crashes before publishing | Resume from a valid result or recompute on the same recorded branches |
| Push succeeds, then the publisher dies before recording it | Recover the exact commit; do not make another commit or PR |
| A status/comment API request times out | Inspect its effect ID before retrying; ambiguity does not produce spam |
| A human pushes while Claude is working | Reject a proposal based on the old head; preserve the human's change |
| Stop races with a result | Once stop is recorded, no older generation can authorize another publish request |
| A write is in flight when the publisher crashes and stop is acknowledged | Allow its already-authorized outcome to arrive, report and reconcile it; issue no new write |
| Main advances while a PR push is in flight | The PR push may finish, but the outdated integration cannot merge |
| A worker uploads a result and then crashes | Only the controller accepts the correctly attributed artifact and advances state |
| A result names the right item but comes from another run/attempt | Reject it; artifact text and names confer no ownership |
| An old CI run finishes after a new head exists | It cannot change the new head's readiness |
| Main and a PR fail in the same job for different reasons | Do not classify them as the same failure without evidence |
| Approval precedes an agent fix with auto-merge enabled | GitHub requires approval covering the new push |
| A lower stack PR merges | Record that PR's completion; keep the remaining work open |
| Session artifact expires | Continue with a fresh session on the existing PRs |
| A state write conflicts or the state branch is missing | Reread on conflict; stop safely on missing state |
| Two publishers receive the same result | The second observes receipts; it does not repeat effects |
| A factory controller run completes | It does not create an endless workflow_run loop |

Then use seeded randomized event sequences: duplicate, delay and reorder
wake-ups, change heads, cancel runs, lose API responses and expire
artifacts. Assert one owner per item, no publish request after its
authorization is invalidated, no overwritten human head, bounded attempts,
and no issue completion before all required work is accounted for. Assert eventual progress only when GitHub and Crew recover, wake-ups
continue, inputs stop changing, and required human decisions arrive.
Save any failing seed and minimize it into a deterministic regression.
Use Quint with `--backend=rust` for this model. Simulation supplements the
scenario tests; it cannot prove GitHub's permissions, API consistency or
approval behavior. Those need real sandbox checks. The executable model
lives in [`spec/factory.qnt`](spec/factory.qnt), with commands and limits in
[`spec/README.md`](spec/README.md). It specifies controller behavior, not a
runtime implementation or a proof that the existing workflows satisfy the
design. The [conformance audit](spec/CONFORMANCE.md) maps each modeled
contract to its actions, invariants and scenarios, and lists assumptions
and exclusions. Passing the model is not a claim that the full design is
modeled. Changes to a mapped contract must update both artifacts and the
corresponding scenarios; trace counts alone cannot establish agreement.

## Today vs. this design

| Area              | Today                                                                                      | This design                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| After hand-over   | Only the conflict sweep                                                                    | The reconciler: reviews, red checks, conflicts, updates                                          |
| Red `main`        | Builds carry a fix, resolves block                                                         | The main-red issue owns it, PRs wait, resolves push their merge                                  |
| Stopped runs      | `agent-blocked` for a question or a crash, and both freeze the PR                          | `agent-needs-you` or `agent-failed`, and crashes retry                                           |
| Where state shows | Labels split across issue and PR, reasons on the issue | Per-PR status and an issue summary, projected from durable records |
| Talking to it     | Labels, `/resolve`, `/effort`                                                              | `@ntodd-agent` in your own words, `/agent <action>`, label shortcuts                             |
| What a run reads  | The issue's comments, once, and the first comment of each review thread                    | Every comment of yours on the issue and its PRs, every thread comment, re-read before each phase |
| Relabeling        | A fresh build, and the old PRs are orphaned                                                | Continues the open PRs                                                                           |
| Merging | By hand, with nothing checking the base was current | Strict checks, serial updates, human-enabled auto-merge and fresh approval |
| Producers | flake-hunt, special-cased | Separate upstream systems, one admission contract |
| Signals           | CI and `review-bots`                                                                       | Plus named check runs, blocking or advisory                                                      |
| Daily sweep       | One cron, running about 8 hours late                                                       | Event-driven, with an hourly backstop                                                            |
| Stacks            | Resolve blocks on them                                                                     | Designed, built in the last phase                                                                |
| Caller | About 150 lines per repo: trust checks, inline jobs, run-name parsing | Triggers and separate shared calls for trusted entry and unprivileged hop |
| Settings          | Inputs in each repo's caller, so a change means a PR to every repo                         | A config file on the default branch, read at run time                                            |

## Plan

Each phase has executable acceptance criteria and goes to
agent-ready-sandbox before other repos. This is a design and model change;
the current production workflows keep their behavior until migration.

1. **Model ownership and recovery in Quint.** Specify operations, claims,
   generations, partial publishing, approval and PR completion. Use the
   lightweight Rust simulator for deterministic scenarios and seeded
   random exploration. Keep the model independent of GitHub API adapters.
2. **State and trusted publishing.** Implement the Git ledger, schema
   versioning, operation receipts and short controller lock. Remove write
   tokens from Claude. Verify branch protections, artifact provenance and
   stale-head rejection in the sandbox before enabling automatic work.
3. **One issue through one PR.** Introduce the thin caller and config;
   build, publish, release Crew, resume on CI, respond to trusted feedback,
   ask/answer, stop/resume and close out. Restore session artifacts only as
   an optimization. Keep exact commands and current aliases first.
4. **Recovery and integration.** Replace the sweep with reconciliation,
   bounded retry and queue deadlines. Add strict checks, serial updates,
   fresh approval and main-failure dependency handling. Test crashes at
   each state/API boundary and migrate existing open work explicitly.
5. **Convenience and broader signals.** Add mention routing, additional
   named checks and the check-run surface when justified. Admission adapters
   can accept more producers without changing the lifecycle. Building
   those producers remains separate work.
6. **Stacks.** Enable multi-PR production only after per-level update,
   partial completion, retargeting and recovery pass the same contracts.

Migration inventories existing issues and PRs from GitHub, revalidates
admission, and creates records without starting replacement builds. It
translates old blocked states into a question or recoverable failure only
when there is evidence. Ambiguous ownership asks you. Keep the old sweep
and new controller mutually exclusive per repo. Start with read-only
reconciliation reports, then enable one sandbox item before broad rollout.

Active entry checks that the old workflow is disabled and that its queued,
running, requested, waiting and pending run counts are all zero before
minting the App write token. Repeat that precondition before controller
actions, worker startup and phase changes, and new publish/API intents.
Read-only reconciliation remains available during migration. An incomplete
inventory or failed run-status read cannot establish isolation. These are
fresh preconditions, not a transaction with an administrator's independent
workflow changes; already-submitted requests can still finish. Sole control
of the App's writes remains an operating assumption.

## Decisions to validate in the sandbox

- **GitHub approval semantics:** record which clean updates need another
  approval. Preserve latest-push approval regardless of the result.
- **State protections:** confirm only allowed identities can write the
  state branch, and that the worker cannot bypass the publisher.
- **Actions routing:** prove trusted default-branch entry, unprivileged
  review hops, worker completion recovery and suppression of wake-up loops.
- **Artifact recovery:** establish result size/retention limits and a
  compatible Claude session format. Fresh-session recovery must work first.
- **Capacity and budgets:** start with the documented defaults, then tune
  using queue time, Crew minutes, model cost and human interventions.

The name `factory`, the public mention handle and a check-run surface can
be settled independently. They do not change ownership or permission rules.

## Platform references

- [Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency): concurrency is a mutex with bounded pending jobs, not the durable work queue.
- [Git reference updates](https://docs.github.com/en/rest/git/refs#update-a-reference): advance the state branch without force and retry conflicting writes.
- [Workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows): event context, default-branch entry and workflow completion restrictions.
- [Issue events](https://docs.github.com/en/rest/issues/events) and [event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types): actor, identity and time evidence for close/reopen recovery.
- [GitHub review rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets): approval after pushes and merge-base changes.
- [Quint simulator and model checkers](https://github.com/quint-co/quint/blob/main/docs/content/docs/what-does-quint-do.mdx): Rust simulation explores sampled traces; it is not exhaustive verification.
