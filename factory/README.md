# Factory implementation

This is the implementation of [DESIGN.md](../DESIGN.md), in progress.
The existing agent-ready workflows remain the active runtime until the
factory's caller, setup and sandbox checks are ready. The new reusable
workflow defaults to read-only planning. A caller generator and review hop
are present; no target repository has an active factory caller yet.

## Implemented

- `lib/protocol.mjs`: pure, validated ledger transitions for admission
  records, attempt reservation, exclusive run/attempt ownership, artifact
  acceptance, stop/revision fencing, publish intent/receipts and aggregate
  completion. Authorization observations are supplied by trusted adapters.
- `lib/store.mjs`: the data-only `factory-state` Git branch, read and
  written through GitHub's API. Conflicts reread and recompute; ambiguous
  writes retain the candidate commit identity and do not blindly retry.
  Normal reads never recreate missing state. Initialization is explicit.
  The protected repository record preserves the App ID and bot login
  verified by setup; regular transactions cannot replace or remove them.
- `lib/publish.mjs`: a short publisher pass. It validates proposed objects,
  records a request before submission, recovers exact effects, and yields
  when an outcome is unknown. It requires a clean writer adapter and a job
  holding the repository's `factory-control` concurrency group.
  An overdue unknown write raises a question bound to its exact request;
  receipt inspection continues without resubmission. Only that request's
  verified outcome clears its recovery question. Known rejections have
  bounded retries and backoff; validation failures retain their reason.
- `lib/config.mjs`: strict YAML configuration pinned to a default-branch
  commit, with defaults, typed bounds and rejection of ambiguous configuration.
  The pinned YAML parser ships in `vendor/` and needs no runtime installation.
- `lib/project-environment.mjs`, `lib/project-setup.mjs`, `worker/context.mjs`:
  declared public values and setup/worker secret names, selected before project
  checkout from `SETUP_SECRETS`. Only selected values enter a private temporary
  file bound to the operation/config/run attempt; setup and model subprocesses
  receive their declared values after fresh ownership checks. Missing secrets
  ask immediately without a model call; script failures return recoverable
  result artifacts. Clean controller/update jobs receive no project bundle.
- `lib/admission.mjs`: fresh issue/own-PR authorization, producer markers,
  command parsing and trusted feedback classification. Original source IDs
  survive relabels; edited or bot-written comments never become commands.
  Classification excludes the verified factory App even when the config
  names it as a review bot. Workers use the protected identity, and active
  controllers compare it with their authenticated App before admitting work.
- `lib/github.mjs`: read-only GitHub facts, including complete REST/GraphQL
  pagination for edit history, reviews, threads and every thread reply.
- `lib/commands.mjs`: durable command ingestion, duplicate suppression,
  control commands, bounded menu routing and consumption on accepted outcomes.
  Complete conversation rereads retire deleted/edited commands and fence an
  active operation whose authorizing source changed.
  Same-second IDs are ordered numerically within a source kind; stop wins an
  otherwise ambiguous tie between different source kinds.
  Trusted issue-label timeline events provide `agent-ready` and `effort:*`
  shortcuts. The original admission label is not replayed as new work, and
  App-written status labels cannot resume an item.
- `lib/usage.mjs`, `lib/accounting.mjs`: durable per-operation model reports,
  exact-run job execution time and per-request mention token usage. Resumed
  Claude totals are interpreted using the detected CLI version. Failed phases
  preserve earlier measurements; missing reports remain explicit. A bounded
  historical scan with persistent backoff includes replaced/stopped attempts.
  Status comments and their JSON expose known totals and missing coverage.
  These are reported estimates and execution minutes, not billing invoices;
  mention dollars and independently invoked model tools remain unpriced.
- `lib/router.mjs`: a tool-free Responses API classifier for mentions. Its
  schema permits only the documented action menu; the
  controller revalidates the human source and reserves each model request.
  Three failed requests become a clarification. Routing runs before worker,
  pause and question waits, so a stop mention can interrupt active work.
  A recorded stop/restart also fences worker/publisher reads if the controller
  crashes before applying the control transition.
  First requests are recorded without coding authority. A supported work
  action must pass fresh admission before any reservation. This includes
  initial requests in review threads on a person's own PR. Status and effort
  alone cannot enroll an issue or PR into automatic coding.
  Routed numbered answers keep their original source text and the trusted
  mention handle, so `@ntodd-agent go with 1` reaches the same question-bound
  decision as an exact answer. A routed stop answer fences writes even if
  the controller dies before applying its control transition.
- `lib/reconcile.mjs`: item/repository decision tables, terminal observations,
  retry and wait deadlines, main-failure dependencies, serial integration,
  aggregate completion and bounded own-PR maintenance. The I/O runner must
  commit the returned state/events before executing actions.
  Closed required PRs need an explicit `/agent answer accept-closure #123`
  disposition or replacement work. A numbered answer is confined to the
  current question and issue revision. Reopening clears the waiver while
  preserving its history; accepting one closure cannot complete other PRs.
- `lib/actions.mjs`: complete artifact discovery for the recorded run attempt,
  workflow/repository/commit provenance, queue status from the actual worker
  job, archive digests and bounded extraction of the two allowed result files.
  Download redirects receive no GitHub credentials.
- `lib/observe.mjs`: fresh authorization, all feedback, required checks bound
  to their configured App, test-merge CI, review/check signals and branch
  integration facts. Default-branch CI is observed by exact SHA; PR bases use
  the actual branch head, and synthetic merge checks need matching parents.
- `lib/failure-report.mjs`, `lib/diagnostics.mjs`, `lib/main-repair.mjs`:
  complete failed-step reports, specific check annotations, check/job/run
  provenance and bounded credential-free log downloads. Check names alone
  never establish shared failures. Mixed reports preserve independent PR
  diagnostics, while unknown formats or incomplete evidence ask for help.
  Admitted main-red reports bind their source key to a base SHA; human
  issues can use trailing `factory:repair-base` metadata. Verified signatures
  stay tied to that base and accepted revision. Matching repair work is
  prioritized; other PRs wait without copying its fix. Dependency questions
  settle only from known changes, and workers receive commit-bound snapshots.
- `lib/controller.mjs`: a bounded I/O runner for discovery, command ingestion,
  reservation, dispatch, exclusive claims, artifact collection, publication,
  hand-over and close-out. Interrupted API requests retain their durable intent.
  Read-only discovery produces prospective admissions in memory. One failed
  discovery candidate cannot hide other work, and a complete conversation
  read still handles stop when CI/rules observations are unavailable.
- `lib/git.mjs`, `lib/writer.mjs`, `lib/publisher.mjs`: Git bundles imported
  into a fresh bare repository, object/path/ancestry validation, expected-head
  writes, draft PR creation and recovery of partially applied publication.
- `lib/worker.mjs`, `worker/`, `update/`: read-only Claude work on Crew with
  fresh instructions between phases, plus clean Git integration without
  executing project code. Both return artifacts and end before publication.
- `lib/restart.mjs`: recorded restart intent, old-owner recovery, guarded PR
  closure and optional issue reopening, then one replacement build. Partial
  closes are recovered; stop fences further requests. Retired PRs remain in
  history, and restarting does not reset the item's automatic daily budget.
- `lib/continue.mjs`: an explicit stop/continue decision for an issue closed
  before its work finishes. Reopening is journaled before submission; lost
  responses, later stop and source changes retain recovery of that request.
  Existing PRs and budgets stay in place. Human reclosure needs a fresh
  decision, and an uncertain reopen cannot keep an obsolete worker running.
- `lib/threads.mjs` and the publisher: assigned thread snapshots, worker reply
  proposals, push-before-reply and reply-before-resolution dependencies,
  exact App markers for recovery, and feedback consumption after successful
  publication. Human PR maintenance cannot modify review threads.
- [`factory-runtime.yml`](../.github/workflows/factory-runtime.yml): separate
  controller, Crew worker and clean-update jobs. The App credential is present
  only in the controller job, which never checks out project code.
- `lib/caller.mjs`, `lib/wakeup.mjs`, `wakeup/` and
  [`factory-wakeup.yml`](../.github/workflows/factory-wakeup.yml): a generated
  thin caller with explicit CI workflow names and a secrets-free PR review
  hop. The hop dispatches only a target hint on the actual default branch;
  fork token restrictions leave discovery to the backstop.
- `lib/setup.mjs`: public setup plans for the caller/config, labels,
  repository auto-merge setting and four rulesets. State writer permissions
  are separate from deletion/force-push protection. Main's strict checks
  have no bypass; latest-push approval retains its separate admin exemption.
  Verification requires full ruleset observations, including bypass actors,
  and rejects missing, inactive or weakened protections.
- `enable.sh`, `setup/`, `lib/setup-{apply,client,journal,options}.mjs`: an
  administrator CLI with preview, App/installation and CI checks, explicit
  state initialization, protected state updates, labels, secrets and a
  caller/config PR. Unknown creates retain a local request record; repeating
  setup inspects their outcomes before another request. Setup never executes
  project code, rewrites a setup branch or merges its PR. Activation refuses
  a live legacy runtime or App PRs without recorded membership.
- `lib/runtime-guard.mjs`: active entry, worker and new publish/API-intent
  checks for a disabled legacy workflow with no live runs. Server-filtered
  counts include queued and approval-waiting runs; incomplete reads withhold
  execution. The active entry checks before minting an App write token.
  Read-only migration reports can still run while the old runtime is active.
- `lib/api-journal.mjs`, `lib/api-writer.mjs`, `lib/surfaces.mjs`: typed API
  intent/receipt records, issue/PR status comments and factory labels,
  command reactions/acknowledgements, question notifications, draft hand-over,
  reviewer requests and issue close-out. Lost create/close responses are
  inspected rather than resent. Repeatable projections have a daily request
  budget, and unrelated human labels are preserved.
  Stop acknowledgements list uncertain requests. Sent API effects that
  remain unknown or rejected raise one attention notice per incident,
  corrected in place after recovery. These alerts do not replace coding
  ownership or recursively generate more alerts when notification fails.
  Close/reopen writes exclude other pending state changes to the same
  target across items. Recovery uses the factory App's state event after
  the recorded preflight cursor and request time; current state alone
  cannot settle a sent request. Successful update responses record their
  receipts directly.
  Identified CI reruns are reserved against an exact run/attempt and commit;
  queued reruns are external waits, and interrupted requests recover by
  observing the new attempt instead of sending another rerun.
- `test/`: fault-injected persistence and publishing tests, authorization
  and provenance boundaries, budget rollover and completion scenarios.
- [`spec/replay.mjs`](../spec/replay.mjs): runs Quint and checks its lifecycle
  projection against the actual protocol after each successful transition.

The current protocol supports one worker-proposed push and, for a new build,
a controller-bound draft PR effect. Membership is recorded from that effect's
receipt. Controller comments and metadata use their own API effect journal.
Worker-proposed review replies and thread resolution are validated against
the operation's assigned threads and a fresh API snapshot. New discussions
after that snapshot leave resolution for another operation.

## Repository setup

For an existing App whose key is held only in GitHub, bootstrap its read-only
caller/config first, using the shared runtime's full commit SHA:

```sh
factory/enable.sh --bootstrap --preview --ref <sha> owner/repo
```

Run without `--preview` to open the draft caller/config PR. Bootstrap uses the
administrator's `gh` login, existing `AGENT_APP_ID` variable and private-key
secret name. The plan explicitly leaves the App unverified. After the caller
is reviewed and merged, the personal repository owner can manually dispatch
`factory.yml` on the default branch with request `{"kind":"inspect"}`. This
performs App/installation GETs in the clean controller job and uploads a
one-day public-metadata artifact. It does not create an installation token,
initialize state or start Crew. The key remains in GitHub. The existing legacy
runtime can remain active during this inspection step.

Consuming that report in administrator setup still needs artifact-provenance
validation; a downloaded JSON file alone is not authority for App identity.
Until that adapter is complete, the normal setup path below requires local
App credentials.

The shared workflows must first exist at the selected remote ref. With `gh`
logged in as a repository administrator and the App credentials saved by
`agent-ready/app/create-app.mjs`, inspect the plan:

```sh
factory/enable.sh --preview --ci CI --check test owner/repo
```

Run the same command without `--preview` to initialize state, configure
protections and open the caller/config PR. The caller defaults to read-only
reconciliation. `--config path/to/factory.yml` supplies repository settings;
otherwise setup retains an existing config or creates one for your login.
`--app-dir` selects a different credential directory. Check names bind to
their observed App on the current default branch; `test@15368` explicitly
selects an App. CI must declare both `pull_request` and `push` triggers.

The App key is sent to `gh secret set` through stdin. Present model/setup
credentials are copied from the environment without printing their values.
Recovery records live under the user's state directory; they contain public
intent and secret fingerprints, not secret values. A killed setup process
can leave a lock: confirm it has stopped before removing that lock and
rerunning. An unresolved create remains pending even when a read shows no
effect. Repeating setup does not authorize blindly recreating it.
Setup also records the verified App identity in protected state. An older
state branch without that identity needs setup rerun before the factory
entry will operate; a mismatching App is rejected before setup mutations.

`--activate` proposes an active caller only after worker credentials exist,
the old runtime is disabled and terminal, and App PR membership is recorded.
It still opens a PR for review. Migration and the live sandbox approval,
permission and event tests remain required before rollout.
Active runtime checks also enforce the legacy precondition after setup;
disabling a workflow alone does not establish that its runs have ended.

Project settings use `.github/factory.yml`:

```yaml
environment:
  values:
    MIX_ENV: test
    PGHOST: localhost
  setup-secrets: [PACKAGE_READ_TOKEN]
  worker-secrets: [DATABASE_PASSWORD]
```

Store the named values in the repository secret `SETUP_SECRETS`, using
`NAME=value` lines or a JSON object of strings for multiline values. Values
are literal; shell expansion and dotenv unquoting are not applied. Names may
appear in both phase lists; they cannot also have a public value. Runtime
control variables, App/attachment tokens and model credentials cannot be
provided through this channel. Both phases share one Crew filesystem, so all
selected secrets must be appropriate for project code in that job. The private
file is removed on job cleanup; it is outside the checkout and artifact paths.
Missing names or malformed bundles produce an issue/PR question before coding.

## Verification

```sh
node --test factory/test/*.test.mjs
npm run vendor:check
npm run model:check
npm run model:simulate
npm run model:replay
```

The runtime is self-contained Node. YAML is bundled from pinned development
dependencies with its ISC license; `npm run vendor:build` regenerates it and
CI checks reproducibility. Quint remains a development dependency. The model covers a bounded subset, described
in the [conformance audit](../spec/CONFORMANCE.md).

Mentions require the explicitly passed `OPENAI_API_KEY`. The router defaults
to `gpt-6-luna` on OpenAI's Decisions API. A single typed choice selects the
action and any effort level together; refusal, confidence below 0.9 or
selected-choice probability below 0.9 asks for an exact command. These are
initial conservative thresholds, not measured accuracy guarantees. It has no tools, a 20-second
request deadline, bounded input/output and at most three durable requests
per mention. Missing credentials or unclassifiable input asks for an exact
command instead. Exact commands never call the router. Coding still uses
the configured Claude worker on Crew.

## Remaining work

- Add attachments. Verify restart, stop/continue, close/reopen evidence, thread replies/resolution, status,
  acknowledgements, notifications and review effects with the App in the
  sandbox, including review-request behavior on draft PRs.
- Validate first-request admission, routing and labels in the sandbox.
- Validate main-failure attribution and repair dependencies with the App in
  the sandbox. Validate usage accounting with a real worker; add billing
  reconciliation and usage from independently invoked model tools. Add
  escalation for surface failures before submission, live project-environment validation and
  complete recovery for authorization/configuration changes.
- Exercise the administrator setup CLI against the sandbox and verify the state protections,
  strict checks and verified latest-push approval. Exercise the reusable
  workflow with a real Crew worker and App in the sandbox.
- Migrate existing work, exercise permissions and event delivery in
  agent-ready-sandbox, then roll out. Finish stack automation in the
  sequence specified by the design.
