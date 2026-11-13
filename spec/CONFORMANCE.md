# Design and model conformance

This is a manual semantic audit of [DESIGN.md](../DESIGN.md) against
[factory.qnt](factory.qnt) and [scheduling.qnt](scheduling.qnt), not a proof
that they are equivalent. The models cover bounded ownership, publishing,
controller queue admission and dispatch recovery within the design.
They do not model the entire issue-handling system.

## Corrections from the audit

The first model and the design were not fully aligned:

1. **Base changes were excluded at the wrong boundary.** The model required
   main to equal the recorded base atomically with a PR branch write. The
   design allows main to move during integration. The model now checks the
   base before authorizing a proposal, allows it to change afterward, and
   relies on current-base integration checks at merge time. A branch write
   does not make an outdated integration safe to merge.
2. **Worker completion advanced the ledger.** `finishWorker` originally
   changed the operation's phase. It now only uploads external data and
   terminates the worker. `collectResult` is a controller transition that
   checks operation and owner identity. Upload-before-crash and foreign or
   old artifacts have separate scenarios.
3. **Requests and effects were conflated.** A crash was possible before or
   after a push, but not while its request was in flight. The model now
   separates submission, remote application and receipt persistence. The
   design's stop guarantee now concerns new requests: an already-submitted
   request can complete after stop is acknowledged. A read showing no
   effect does not establish that the request failed.
4. **Phase names differed.** `result` is now `result-ready`; obsolete
   proposals become `superseded` rather than implementation failures.
5. **Coverage was too easy to overread.** A pair of existing PRs does not
   model issue admission, PR creation, stack ordering or the reconciler's
   whole decision table. Those exclusions are now mapped below.

## Modeled contracts

Each row identifies a design obligation, its model representation and
focused scenarios. "Modeled" means those transitions are exercised and
properties checked on sampled traces, not that every trace is proved safe.

| Design contract | Model actions and properties | Scenario tests |
| --- | --- | --- |
| [Dispatch and recovery](../DESIGN.md#dispatch-and-recovery): reserve before dispatch; duplicate delivery does not allocate a second owner or budget | `reserve`, `dispatch`, `claim`, `rejectDelivery`; `oneOwner`, `boundedAttempts` | `duplicateDispatchTest`, `changedHeadCannotClaimTest`, `deadWorkerRetryTest` |
| Controller queue admission and recovery before claim | `scheduling.qnt`: `arrive`, `deliver`, `cancelPending`, `crashControl`, `dispatch`, `ask`; `filteredBeforeQueue`, `boundedDispatch`, `oneOwner` | `selfSurfacesPreserveWorkerTest`, `nonWorkerCompletionsPreserveWorkerTest`, `displacedWorkerRetriesSameReservationTest`, `exhaustedDispatchesAskTest`, `lostCompletionBackstopCollectsTest` |
| A queued owner still owns the operation; cancellation request is not termination | `live`, `running`, `requestCancellation`, `crashWorker`, `recoverDeadWorker`; `oneOwner` | `queuedOwnerCannotBeReplacedTest`, `deadWorkerRetryTest` |
| Stop invalidates new work from the old generation; it waits for a live publisher's lock | `stop`, `resume`, `discardStale`, `authorizePublish`, `push`; `authorizedPublishRequests` | `stopFencesResultTest`, `stopWaitsForPublisherTest`, `noNewRequestAfterStopTest` |
| [Worker contract](../DESIGN.md#worker-contract-and-releasing-crew): workers return artifacts, controller advances state | `uploadResult`, `finishWorker`, `collectResult`; `acceptedResultHasOwner`, `waitsReleaseCrew` | `workerCannotAdvanceLedgerTest`, `crashAfterArtifactUploadTest` |
| Artifact identity must match the operation and claimed run/attempt | `foreignArtifact`, `collectResult`; `acceptedResultHasOwner` | `foreignResultCannotBeCollectedTest`, `oldResultCannotBeCollectedTest` |
| A missing result can be recomputed within budget without starting another issue | `expireResult`, `recoverMissingResult`, `reserve`; `boundedAttempts` | `missingArtifactTest`, `automaticBudgetTest` |
| [Publishing after a crash](../DESIGN.md#publishing-after-a-crash): recover the exact applied commit even without a receipt | `push`, `applyPush`, `crashPublisher`, `recoverPublished`; `noDuplicatePush`, `receiptsHaveEffects` | `pushBeforeReceiptCrashTest`, `stopAfterUnrecordedPushTest` |
| An uncertain request may still apply; do not infer failure or replace it | `pending`, `rejectPush`, `recoverUnpublished`; `unresolvedPublishKeepsOperation` | `unresolvedRequestCannotRetryTest`, `unresolvedRequestCannotReplaceOwnerTest` |
| Definitive rejection allows revalidation and retry | `rejectPush`, `finishRejectedPublish`, `recoverUnpublished` | `rejectedRequestCanRecoverTest`, `rejectedRequestWithoutCrashTest` |
| A request submitted before stop can complete afterward, without resuming the item | `push`, `crashPublisher`, `stop`, `applyPush`, `recoverPublished`; `authorizedPublishRequests` | `delayedPushAfterStopTest` |
| A human push must not be overwritten by an old proposal | `humanPush`, `rejectRacedPublish`, expected-head guard in `applyPush`; `noHeadOverwrite` | `humanPushDuringPublishTest`, `delayedPushCannotOverwriteHumanTest` |
| Main can advance while a PR write is in flight; the old integration cannot merge | `mainMoves`, `applyPush`, `merge`; `reviewedIntegration` | `mainMovesDuringPublishTest`, `outdatedIntegrationCannotMergeTest` |
| [Merging and approval](../DESIGN.md#merging-and-approval): agent changes need approval covering the new head and passing current integration checks | `approve`, `observeCI`, guards in `merge`; `reviewedIntegration` | `oldApprovalCannotMergeTest`, `oldCICannotMakeNewHeadReadyTest` |
| A late push to an already-merged PR branch is not landed work; completion needs verified coverage or an explicit alternative | `merge`, `applyPush`, `verifyLanding`, `acceptCompletion`; immutable `merges` history, `verifiedLandingIsReal`, `completeMeansAllMerged` | `mergeWhilePushInFlightTest`, `latePushCannotCompleteTest`, `latePushNeedsDispositionTest`, `rewrittenPublicationNeedsDispositionTest`, `landingEvidenceWaitsForReceiptTest` |
| A merge away from the default branch is a recorded outcome, not default-branch coverage, even with no factory publications | `mergeAway`, `landMerge`, `verifyMerge`, `acceptCompletion`; `defaultMerges`, `verifiedMerges`, `acceptedMerges` | `offDefaultMergesCannotCompleteTest`, `offDefaultMergeCannotVerifyTest`, `offDefaultPublicationCannotVerifyTest`, `offDefaultMergeCanLandLaterTest`, `offDefaultMergesNeedDispositionTest` |
| [PR and issue state](../DESIGN.md#states-and-where-you-see-them): merging one required PR does not complete all work | `merge`, `closeOut`; `completeMeansAllMerged` also requires terminal ownership and accounted publications | `partialCompletionTest`, `fullCompletionTest` |

## Abstraction boundaries and assumptions

| Design area | What the model does | What it does not establish |
| --- | --- | --- |
| Accepted issues and PR membership | Starts with one authorized issue and two known required PRs | Admission, content revisions, grouped-issue authority, PR creation, membership changes |
| Durable Git ledger | State transitions stand for successful atomic ledger transactions; the long publisher lock is explicit | Git ref conflicts, schema migration, missing/corrupt state, real branch protections or storage durability |
| Controller serialization | `factory.qnt` abstracts atomic controller actions and the publisher lock. `scheduling.qnt` separately represents one active/one pending control job, pending replacement and pre-queue filtering | Actual Actions enforcement, multiple repositories/items or discovery of lost commands. The two models are separate projections, not a composed whole-system proof |
| Run identity and artifact provenance | `(operation, runId)` represents a unique operation and complete run/attempt identity | GitHub identity authentication, artifact digests, schema/content validation, token isolation or forged API responses |
| Publishing | One proposed commit and one branch effect per operation; no force pushes; an uncertain remote request remains pending | Multi-effect publishes, comment/PR deduplication, attachments, branch creation, repository hooks, actual API consistency |
| Expected-head update | `applyPush` atomically checks the PR head; main and ledger are separate | That a chosen GitHub adapter implements this guard correctly; sandbox tests must establish it |
| Ambiguous remote outcomes | `pending` includes a sent request or an intent whose submission/outcome is unknown; `rejectPush` supplies definitive no-effect evidence | A timeout or an unchanged branch is not modeled as rejection. If real APIs cannot resolve uncertainty, the design must escalate rather than assume this transition is available |
| Retry budget | Three reservations in one window, including queued attempts; redispatch spends no extra reservation | UTC rollover, explicit human overrides, repeated-failure thresholds, round limits, cost caps and API retry budgets |
| Reconciler scheduling | `step` nondeterministically selects protocol operations; `recoveryStep` explores stable-input recovery | The design's full first-applicable-action ordering, reasons for new work, fairness, serial integration selection, priority and deadlines |
| Main health, CI and review | Exact numeric head/base identities and successful CI observations; approval is attached to a head | CI failures, flaky reruns, failure matching, main repair dependencies, review threads, bot policies, review dismissal/revocation and signal timeouts |
| Merge policy | `merge` represents a human-authorized GitHub merge with strict approval/check guards | Automatic merge is not an App action here. The model does not track enabling auto-merge, admin bypass, GitHub's actual approval implementation or queued merge behavior |
| Completion | Both fixed required PRs must merge; merged commit identity stays in the audit history. Merges elsewhere need later default integration and a trusted read, or a fresh abstract human disposition. Commit ancestry carries operation coverage; human rewrites can remove it. Applied publications need verified coverage or a fresh abstract human disposition | API repository/base/ancestry/tree proof validation, question/revision/command binding, closed-PR alternatives, replacement PRs, abandoned issues, reopening or stack base dependencies. JavaScript scenarios cover the concrete proof and disposition boundaries |
| Session and runner lifecycle | Workers terminate before controller acceptance/publishing; expired result data can trigger another attempt | Claude session format, fresh-context reconstruction, filesystem isolation, result schema or model output quality |
| Progress | Named scenarios show that recovery and completion are possible; witnesses measure sampled reachability | Eventual progress or fairness. `idle` can repeat indefinitely; neither simulator profile proves liveness |

The shorter model deliberately allows arbitrary operation selection once
an attempt finishes. This explores protocol safety under more scheduling
choices than the intended reconciler, but cannot validate its scheduling
policy or progress. The two PRs are independent branches; they exercise
aggregate completion, not bottom-up stack automation.

## Keeping the artifacts aligned

For changes to a contract above:

1. Update the design and mapped model transitions together. If the model
   deliberately omits the change, update the boundary table explicitly.
2. Add a scenario that would fail under the previous interpretation, and
   rerun `npm run model:check` and both simulation profiles.
3. Inspect witnesses; ensure the changed behavior is reachable, including
   useful progress and the fault path. A zero-hit witness is not evidence.
4. Challenge important guards with a temporary weakened model and verify
   that its invariant or scenario fails. Do not merge weakened variants.
5. When the JavaScript controller is implemented, replay model traces
   against its adapter. `npm run model:replay` now replays named scenarios
   and sampled traces through `factory/lib/protocol.mjs`, comparing phase,
   owner, generation, budget, expected commits, actual merged commits,
   verified landing coverage and aggregate completion at
   each step. This is protocol evidence; live GitHub adapters and the full
   reconciler still need their own conformance checks.

CI runs the scenarios and simulations. It does not mechanically prove
that English prose and Quint have the same meaning; this table is a review
obligation, not an automatic equivalence check. GitHub sandbox validation
remains required for every platform assumption listed above.

## Implementation evidence

The first implementation lives in [`factory/lib`](../factory/lib): the
pure operation protocol, the Git-backed state store, and a publisher
coordinator that records intent before invoking its writer adapter.
[`factory/test`](../factory/test) covers conflicting writers, ambiguous
state responses, artifact provenance, retry budgets, aggregate completion,
and interrupted publishing. This code is not yet the full reconciler or
a deployed workflow.

[`replay.mjs`](replay.mjs) runs the actual Quint Rust engine, decodes its ITF
traces, and feeds successful controller transitions into the implementation.
It compares the durable lifecycle projection at every state, rather than
just the final outcome. Worker/API events remain external observations;
the model's remote application step is not incorrectly treated as a
persisted receipt. Expected disabled steps from `.fail()` scenarios are
tested separately in the protocol tests, since they are not successful
transitions in the exported traces.

Replay found that `claim` allowed an outdated PR head in the original
model. The design, model and protocol now check the recorded head and open
PR at claim time; `changedHeadCannotClaimTest` is the regression scenario.
The replay does not validate repository permissions, GitHub event routing,
commit import/validation, request delivery or the complete scheduling policy.

## Additional implementation coverage

The bounded Quint model still omits admission, full scheduling and command
interpretation. Those now have JavaScript implementations and scenario tests
in `factory/test/{config,admission,commands,github,reconcile,repository}.test.mjs`.
They exercise the design's YAML example, default-branch pinning, trusted
source history, nested pagination, command deduplication, wait deadlines,
current-head CI, mixed main/PR failures, feedback revisions and one repository
integration selection. They do not expand Quint's formal scope or establish
end-to-end workflow conformance.

Mention classification, label shortcuts and the review wake-up hop are also
outside Quint's scope. `router.test.mjs` checks the fixed menu, refusal and
incomplete-output handling, bounded input/output, and the absence of tools
or GitHub credentials in model requests. Controller scenarios exercise a
stop mention during a live worker, duplicate wake-ups, exact-command bypass,
three-request exhaustion, and relabeling an existing PR. `assignment.test.mjs`
and `observe.test.mjs` cover a crash after a routed stop/restart is recorded
but before its control transition is applied. `wakeup.test.mjs` checks the
generated caller's permissions and a hint-only dispatch to the default
branch. These are JavaScript and workflow-shape checks; live event delivery,
token permissions still require sandbox validation. Additional admission
scenarios cover request-only records, first issue and own-PR thread mentions,
fresh reauthorization before coding, changed sources and untrusted edits
during routing, read-only discovery, and isolated discovery/CI API failures.
The bounded model starts after admission and deliberately omits these records.

Command scenarios also retain stop/restart ordering across late-visible API
facts: old work cannot resume a recorded stop, and an older control cannot
revoke a newer admitted explicit request. This ordering is outside the model's
abstract stop/resume actions. `setup.test.mjs` checks generated branch rules
and challenges the verifier with weaker checks/approval, extra bypass actors,
wrong scopes and omitted bypass metadata. Those definitions do not establish
that GitHub enforces them; the live permission and approval tests remain open.

The administrator setup CLI is outside the Quint model. Setup scenarios
exercise repeat invocation, interrupted rule/branch/PR creates, unknown
outcome retention, preservation of stronger review rules, effective state
restrictions, credential handling and activation guards. A separate process
runs the actual preview entry with instrumented GitHub/gh adapters and rejects
every mutation; it also checks that no journal or credential is printed.
The setup REST adapter has read the sandbox's actual CI, check identities and
full ruleset shapes. This is read-only evidence; App-backed writes and live
approval semantics remain unverified.

A connector GET recheck at 2026-11-12 17:05 UTC found sandbox setup unapplied:
repository `1449400573` still uses `main` at
`7778370ffc7016df5023faa3f538bd544fb2ef7f`, with auto-merge disabled. Reading
that default ref succeeded, while `git/ref/heads/factory-state` returned 404.
The complete ruleset collection contained only legacy ruleset `26758485`,
scoped to the default branch. Its full response requires last-push approval
and retains the administrator exemption, but contains no strict status checks
or state-branch protections. No mutations were attempted. These observations
establish outstanding setup work, not permission or approval enforcement.
The connector rejected the workflow-catalog endpoint; it supplies no current
legacy-isolation inventory. CLI authentication was unresolved at that point.

The previously approved [sandbox PR #17](https://github.com/ntodd/agent-ready-sandbox/pull/17)
was merged at `f7b354d438ec6250b146ffedefadf9c7f4a23872` at 17:12 UTC.
Its exact head `e317fec2e1f708d1f3ce84b9975bd142cc74a4ba` had a successful
`test` check. The diff installed only the config and a read-only caller pinned
to `d2a6b3fc40695b397bb86694f2b81f09bb8fccba`; it did not activate the factory.
The resulting [factory push run](https://github.com/ntodd/agent-ready-sandbox/actions/runs/43266937488)
failed before creating any jobs (`jobs: []`). Local cross-workflow actionlint
validation against those pinned shared files passes, so it does not reproduce
the GitHub startup failure. The connector's run metadata provides no validation
error and there is no job log. The user supplied GitHub's validation message:
`Workflow 'factory' cannot listen to itself.` This is negative live evidence,
not a successful controller or event-loop test.
The separate [CI push run](https://github.com/ntodd/agent-ready-sandbox/actions/runs/43266941198)
failed `Tipper.TipLogTest` with seed `656758`; no test source changed in #17.
At that point owner-only App inspection had not been dispatched: the CLI
keyring token was invalid and computer-use inventory reported no browser session.

Sandbox correction `0e08851b2b0f7e62e911b53c0d61bd1064d27db8` removed only
`factory` from the installed read-only caller's completion subscriptions.
The pinned shared SHA and `dry-run: true` stayed unchanged. Its
[factory push run](https://github.com/ntodd/agent-ready-sandbox/actions/runs/43321963525),
[CI run](https://github.com/ntodd/agent-ready-sandbox/actions/runs/43321962112)
and [CI-completion factory run](https://github.com/ntodd/agent-ready-sandbox/actions/runs/43322030278)
all succeeded. The clean control job ran with the expected pinned SHA and
read-only setting; worker/update jobs were skipped. State is not initialized,
so this establishes bootstrap entry and a CI wake-up, not work reconciliation,
App inspection, publication or worker completion recovery.

GitHub's self-listening restriction makes the literal subscription described
in DESIGN.md invalid. The generator implements its intended completion path
with a distinct thin `factory-completion.yml` caller listening to `factory`.
The main caller listens only to configured CI names; both factory names are
reserved against CI-name collisions. The completion entry requires a
default-branch `workflow_run` identity, a matching API run and the explicit
`completion-entry` contract. Existing job and ledger guards still filter for
dispatched, recorded worker operations before minting write access. Worker
run provenance remains `factory.yml`; no terminal-owner check is relaxed.
Bootstrap publishes only the read-only main caller/config. Administrator
setup also publishes the completion caller, and rejects older shared runtimes
without its declared input. Bootstrap refuses an already-active completion
caller. JavaScript scenarios cover these boundaries and both generated
callers pass cross-workflow actionlint. The new completion caller has not yet
been deployed; live worker recovery remains required. These workflow-routing
details remain outside Quint's ownership projection.

After the owner refreshed CLI authentication, the read-only
[App inspection](https://github.com/ntodd/agent-ready-sandbox/actions/runs/43344832874)
succeeded on 2026-11-13 at default head
`0e08851b2b0f7e62e911b53c0d61bd1064d27db8`, shared SHA
`d2a6b3fc40695b397bb86694f2b81f09bb8fccba`, attempt 1. Both actor fields
were `ntodd`; worker/update jobs were skipped. Artifact `14001650564` has digest
`sha256:9716d874b56b2269ec4dbd48467e706eb2ae59a274b1d2d374fcac87df3ee448`.
The production `readAppInspection` adapter downloaded and accepted it against
the live run/job/caller identities, digest, current App variable and current
repository state, using only the administrator's GitHub login and no local
App key. It verified App `5656598` (`ntodd-agent`) and active installation
`179581506`, with contents/issues/pull-requests/actions write and checks/statuses
read. Neither permission map grants administration or workflows access.
`factory-state` still returned 404 afterward. This proves declared identity,
installation metadata and authenticated artifact consumption for this run;
state setup, effective write restrictions, Crew isolation and approval
enforcement remain separate live gates. The report is deliberately fresh-run
and current-head bound, not a reusable authorization file.

Config parsing uses a pinned bundled YAML parser, regenerated and checked
against its source by the build scripts. GitHub read queries have also been
accepted by the live API for this repository's issue/PR edit history,
reviews and thread lists. Large nested pagination is exercised by API fakes;
production artifact, token, worker, publish and event-delivery checks remain
part of the sandbox rollout.

The sandbox caller-upgrade PR exposed an additional live event boundary:
`pull_request_target` run `43345761427` reports the PR head SHA/branch in the
Actions API, while its job executes the default-branch base. Entry validation
now checks that base SHA, branch and repository against the run's PR metadata,
independently checks the reported head, and retains the default-branch caller
gate. A regression reproduces the live response and rejects mismatched bases,
heads, repositories, event kinds and refs. It failed before the fix; all 790
Node tests pass afterward. This adapter correction changes no Quint semantics.

Administrator setup created the sandbox's four managed rulesets, then stopped
because GitHub returned the state-writer `update` rule without its optional
false `update_allows_fetch_and_merge` parameter. Verification now accepts that
omission while still rejecting an explicit true value. The live response is
covered by a regression that failed before the fix; all 791 Node tests pass.
The administrator journal retains the successful creates for setup recovery.

The first active sandbox pass admitted issue #20 and reserved one build, but
worker dispatch `43348593956` was canceled before claiming: App-written status
comments and labels created newer jobs in the same single-pending concurrency
group. Active caller generation now uses setup's verified App login to skip
its issue/comment surfaces, PR label surfaces and review-reply wake-ups before
the reusable job enters that group. Human and producer events, other review
bots, App worker dispatches, PR publication/head changes and worker completion
remain enabled. The regression reproduces the suppressed and retained event
classes and failed before the fix. This changes routing, not protocol or Quint
semantics; the ledger representation and its measured read cost are unchanged.

Canceled reconciliation dispatch `43349718541` also exposed redundant completion
jobs competing with real worker requests. The generated primary caller now
names worker dispatches `factory worker` and all other runs `factory reconcile`.
Both the completion caller and the shared control job require the worker name
before entering control concurrency; the in-code wake-up guard agrees. The
name is only a scheduling hint: collection still requires recorded ownership
and verified run/artifact provenance. Regressions reject inspection, migration,
reconcile and unnamed dispatch completions, while retaining worker and CI
wake-ups. The regression failed before the fix; no protocol/model semantics
changed.

The owner changed the execution-placement requirement during rollout: every
factory job must use Crew, including API-only work. The design now states that
policy explicitly. Control and clean update use `crew-s`, review wake-ups use
`crew-xs`, and the coding worker retains its configured runner (`crew-l` by
default). Crew provides one disposable VM per job; the App credential remains
only in the clean controller, which checks out pinned tooling rather than
project code. A workflow-policy regression rejects the previous hosted runner
placement and preserves those credential/checkout boundaries. Runner placement
is outside the bounded Quint model; ownership and publication semantics are
unchanged.

Live controller failures exposed the cost of rereading every ledger object on
every transaction. The data adapter now keeps a per-job cache of immutable Git
objects addressed by SHA, capped at 32 MiB and 20,000 entries. Ref reads remain
uncached, cached values are copied, and failed reads and writes are never
cached or blindly retried. The ledger layout, CAS and unknown-write recovery
are unchanged. The measured cold costs remain 5 GETs for one item and 205 with
200 historical operations; a subsequent no-op transaction takes 1 GET in both
cases. Errors expose only selected numeric rate-limit headers and a fixed
quota classification, never response text or credentials.

Merged sandbox PR #23 produced run `43352257485` with an empty API
`pull_requests` list. Closed PR target events now use the runner event only
to select a lookup number, then require a fresh closed same-repository PR
whose head matches the run and a current default-branch SHA matching the
executing/configuration commit. Missing event identity, a reopened PR, a moved
default head and mismatched repository/head/base facts remain rejected. The
existing open-PR entry checks are retained. This is adapter coverage outside
the Quint model, with a regression that failed on the prior implementation.

The live pre-claim cancellations exposed an omission in the original ownership
model. [`scheduling.qnt`](scheduling.qnt) now represents the Actions controller
queue, pending-job replacement, lost dispatch delivery, cancellation/crash
before claim, durable dispatch backoff and exhaustion, and lost completion
wake-ups. Thirteen named scenarios exercise those failures and recovery;
the sampled profile explores 10,000 traces of up to 100 steps. Progress still
requires a delivered backstop, available APIs and eventual scheduling; neither
model proves fairness or inevitable completion.

[`scheduling-replay.mjs`](scheduling-replay.mjs) compares the model's twelve
event classes with the generated caller subscriptions, job filters and worker
run-name, the shared job filter and the in-code completion guard. It feeds
dispatch, claim, exhaustion and collection through the actual reconciler and
reducer and compares durable state after every transition. Queue replacement
does not create another coding reservation or retire its owner. Temporary
weakened variants were rejected for both App surface admission and non-worker
completion admission. Platform payloads, runner placement, rate limits and
cache correctness remain outside these models; their adapter and live checks
are still required.

The sandbox also exposed a concrete serialization mismatch: the Git ledger
sorts JSON object keys, but API-effect and measured-usage identity checks
compared insertion-ordered JSON strings. Recovery now compares those objects
structurally while retaining immutable payload/measurement guards. API journal
fixtures use the actual canonical serializer, and regressions cover recovery
after response loss, nested key reordering and rejection of changed values.
This adapter correspondence defect is not a new abstract protocol transition.

At the owner's request, the mention classifier now uses OpenAI's Decisions
API with `gpt-6-luna`, replacing Responses text/JSON generation. One choice
encodes both action and effort, so the provider cannot return inconsistent
pairs. Refusals and decisions below the initial 0.9 confidence or selected
probability threshold map to clarification. Fixtures follow the official
Decisions response schema, including the absence of a response ID. Token
measurements retain their provider source and historical Responses records
remain valid. Unit scenarios cover all effort choices, malformed answers,
distributions, refusals, thresholds, missing credentials, bounds and own-PR
restrictions. Threshold calibration and live classification accuracy require
labeled repository requests and a configured OpenAI key; Quint does not
establish model accuracy. This is an explicitly requested router change;
workflow admission, the command menu and protocol authority are unchanged.

The implementation now includes a bounded controller I/O runner, a clean Git
bundle publisher with a journaled draft-PR effect, a read-only Crew worker,
an API-only update job and a reusable Actions workflow. Scenario tests drive
one admitted issue through artifact acceptance, publication, hand-over and
completion; temporary Git repositories exercise expected-head races and clean
integration. Artifact tests verify attempt provenance, archive digests, queue
ownership and rejection of unsafe entries. These additions do not expand the
Quint model's scope. Live Actions routing, App permissions, Crew isolation,
approval semantics and the remaining lifecycle effects are still unverified.

Controller API effects now have a separate typed journal in the item record.
Tests cover comment/close-response loss, projection repair, daily API budgets,
command acknowledgements, question occurrences, draft hand-over, review
requests and revalidation before close-out. None of these API effects is in
the bounded Quint model. They must not be presented as formally modeled or
as live GitHub integration evidence.
Handover scenarios bind both readiness actions to the head observed during
planning. A later push cannot be substituted by the action runner. Human-PR
maintenance revalidates authorization, current-head CI, the default branch
and terminal ownership before recording handover, without acting on the
person's review threads or creating metadata effects. These checks are also
outside the model's merge-policy abstraction and need live sandbox validation.
CI-rerun scenarios bind the original run, attempt and commit, recover a lost
response from the next observed attempt, and keep queued/running reruns as
external waits. These also remain outside the bounded model.

Restart and thread publication now have JavaScript scenario coverage.
Restart invalidates the old generation, waits for terminal ownership and
known publication effects, journals PR closes, preserves retired membership
and admits a single replacement build. Thread proposals are confined to
assigned IDs and fresh discussion snapshots; tests cover push/reply/resolve
ordering, response loss, mid-run corrections, stop and new discussion.
Feedback is consumed only after successful publication; omitted thread
responses remain unhandled. These multi-effect and changing-membership
contracts are outside Quint's fixed-PR, one-push abstraction.

The publisher can now abandon unsubmitted stale effects once all earlier
requests are known. Applied effects and receipts remain in the audit trail.
This prevents a push followed by an unsubmitted PR create or reply from
holding a stopped item indefinitely. The bounded replay still checks the
single-effect protocol; it does not establish conformance for the additional
API effect types. Live schema reads accepted the thread mutation input
names and full database ID fields; no live thread writes have been validated.

Reconciler tests also check that merging during an uncertain publication does
not skip receipt recovery. Accepted issue edits trigger work on the existing
PR; a revision first observed after all required PRs finish needs an explicit
completion decision. Command deletion/edits fence an active operation. These
admission/scheduling rules remain outside the model and are covered by the
JavaScript scenario tests rather than the trace replay.

Landing is separate from publication in both artifacts. The model records
which operations actually reached merged history, preserves that coverage
through ordinary descendant commits, and allows a human rewrite to drop it.
`verifyLanding` abstracts a successful read after receipt recovery;
`acceptCompletion` abstracts a fresh human decision about the current work.
`mergeAway` records a merge elsewhere without advancing the default branch;
`landMerge` and `verifyMerge` separate later integration from its observation.
Completion requires each merged PR's verified default coverage or explicit
acceptance, including items with no factory publication. Neither acceptance
nor verification changes the recorded merge commit. The JavaScript protocol
also requires a revision- and publication-bound question for unverified code,
and scopes a decision to already-reserved generations. `landing.test.mjs`
exercises exact commit, ancestry and tree proofs, malformed API identities,
bounded reads/backoff, missing-evidence escalation, stale answers, restarted
work, own-PR maintenance and the external issue-close guard. Live merge
methods and API consistency remain sandbox assumptions, not replay evidence.
`default-landing.test.mjs` covers the reproduced terminal-state adapter gap:
closed PR observations now retain their merge base. An observed default-base
merge needs a fresh repository identity/default read; off-default results need
exact commit, ancestry or tree evidence on the default branch. Positive proof
is historical and durable across later branch renames or default changes.
Unknown reads share the bounded landing budget and backoff; missing coverage
blocks the reducer and the external issue-close guard. Explicit alternatives
bind the merged PR snapshot as well as the issue revision and publication set.
For a previously admitted human PR that closed after retargeting, the reader
still revalidates original trusted authorship, edits and command identity so
the completion question can be answered. This terminal observation cannot
admit new off-default maintenance, and the publish guard remains closed.
Admission and reader-to-reconciler scenarios cover both boundaries; they are
outside Quint's abstract admission projection.
Temporary weakened copies were checked with seed `20261111`: removing the
publication-coverage guard made `latePushCannotCompleteTest` fail, and
allowing verification without actual landing made
`rewrittenPublicationNeedsDispositionTest` fail. The weakened copies were
discarded; neither result establishes live GitHub proof semantics.
Removing the required-merge coverage guard from temporary model and runtime
copies also failed `offDefaultMergesCannotCompleteTest` and the non-default
merge JavaScript regression, respectively. The parent runtime returned
`close-out` for that regression where the fixed runtime asks for disposition.

Publish recovery now has a 15-minute default deadline. JavaScript scenarios
bind its escalation question to the exact uncertain request, continue
inspection while stopped or without an Actions artifact, and clear only
that recovery question after a verified outcome. A human answer cannot
establish the remote result. Definitive rejections have bounded retries and
backoff; exhausted requests and validation failures become questions.
API surface incidents retain their request identities and notification
history, settle in place, and do not discard code work or recursively
notify about notification failures. The bounded model covers uncertainty
and receipt recovery, but omits these deadlines, questions, API effects
and notification projections. Their coverage is in the protocol,
reconcile, publish, publisher, API-journal, surface and new-PR tests.
Reconciler questions consume the queued request they conclude, including an
exhausted response round, an observation deadline and required-PR closure.
Repeated passes retain the question identity and can reach a later answer.
Ordinary external waits and uncertain publication recovery keep their queued
requests; asking about a failure does not establish a remote outcome. These
command/question distinctions remain outside the bounded model.

Failed reads during pre-submission validation use the same durable read
backoff as failed authorization observations. Actions transport/JSON/body
failures, remote Git fetch/head failures and PR/thread lookup outages retain
the accepted proposal without recording a validation defect or another
worker. Successful rereads still run the artifact/object/target checks and
fresh submit guard. Oversized or malformed artifacts and unrelated PRs remain
validation failures. Focused publisher, Actions, Git, new-PR and thread
scenarios exercise both paths, recovery after the read deadline, and attention
resolution. In Quint these reads are abstracted by `idle`; transport error
classification, retry timing and the validation algorithms remain outside
the model and need adapter tests and live sandbox evidence.

Closure dispositions remain outside Quint's all-merged completion model.
The JavaScript protocol, reconciler and controller scenarios cover fresh
trusted `/agent answer accept-closure #N` requests, question/revision-bound
numbered answers, partial completion, rejection of edited or untrusted
sources, and reopening without reusing an earlier waiver. Surface tests
check that the question appears on the affected PR and acknowledges the
specific accepted closure. These are local adapter scenarios; live App
comments and issue closure still require sandbox validation.

App identity is also outside the bounded model's post-admission starting
point. Setup records its verified ID/login in the protected repository
record, storage preserves it, and active entry compares it with the App
authenticated by its credential. Config, admission, worker-assignment and
controller scenarios exercise App output remaining data despite a changed
mention handle or self-registration as a review bot. Store and setup tests
reject silently replacing/removing that identity; worker reads stop if it
changes or disappears. Live identity and state-write permissions remain
sandbox obligations.

Early issue closure and continuation remain outside Quint's fixed-PR
protocol. The JavaScript continuation scenarios drive the controller and
typed API journal through current question/revision answers, stop, bounded
rejections, response loss, changed sources, human reclosure and work finishing
while a question is waiting. They retain existing workers, PRs and budgets;
an uncertain reopen does not prevent cancellation of an obsolete worker.

API state recovery now records the complete preflight event cursor. A lost
close/reopen response needs a newer state event by the factory App and the
recorded request time. Another pending state change to the same target
blocks new requests, including across items. Tests reject old App events
and human state changes as proof and record historical App effects even
after a later reclosure. Successful update responses are receipts without
depending on a subsequent read. The model's one-push expected-head guard
does not establish these REST semantics. Complete authoritative event reads,
sole ownership of the App's state-changing requests, live event timing and
response behavior still need sandbox validation.

Continuation tests also run 30 seeded traces with 25 controller passes
each, retaining unknown requests through duplicate observations, delayed
application, stop, edited sources and human state changes. Witnesses require
late application after stop, human reclosure and source changes to occur.
These are local stochastic adapter scenarios, not additional Quint coverage.
Routed numbered-answer scenarios preserve the original mention text and
bind normalization to the trusted handle; they cover issue continuation,
PR closure and revised-issue completion. A routed stop answer is checked
before its control transition is applied.

A read-only sandbox probe on 2026-11-12 exercised the real GitHub reader
and API writer against issue #12 and PR #13. Their close events had stable
numeric IDs, actors and timestamps. Both were human-authored and correctly
remained unknown as evidence for a hypothetical pending App close request.
This validates the negative adapter path and response shape, not App writes,
positive App-event recovery, event delivery timing or merge protections.

Main failure diagnostics and repair dependencies remain outside the bounded
Quint model. Reader/parser scenarios bind evidence to exact commits, check
providers, jobs, run attempts and failed steps; they reject partial reports,
generic exit annotations, unrelated errors and changed check attempts.
Controller scenarios cover shared and mixed failures, human and producer
repair admission, historical signature relevance, paused repairs, overdue
questions and current-main recovery independently of issue closure. Worker
snapshots retain diagnostics as data and cannot replace required CI.

A read-only probe on 2026-11-12 exercised the real reader, failed-step
download and parser against sandbox main commit
`7778370ffc7016df5023faa3f538bd544fb2ef7f`, check/job `129870785747`, run
`42828148855` attempt 1 step 10. It classified the complete ExUnit assertion
in `test/tipper/tip_log_test.exs` and reobserved the same failed check. This
is positive diagnostic-adapter evidence using a local administrator token;
Actions-token permissions, App-backed repair lifecycle and merge protections
still require live sandbox validation. This adds no formal-model coverage.

Usage accounting is outside Quint's bounded lifecycle projection. JavaScript
scenarios cover cumulative and older invocation-scoped Claude reports,
partial/malformed measurements, token usage before route validation, exact
run/job provenance, cancelled queued jobs, duplicate collection, bounded
historical recovery and durable backoff. Failed/replaced/stopped attempts
retain measurements across budget rollover; collecting them grants no work
authority. A read-only sandbox job query confirmed actual Crew job IDs,
attempt/head fields, runner assignment, labels and elapsed timestamps. It did
not execute the new workflow or establish invoice amounts. Live worker
accounting, billing reconciliation and independent model-tool usage remain
unverified or incomplete; none is implied by lifecycle trace replay.

Project environment selection is outside the Quint model. JavaScript and real
subprocess scenarios cover pinned config declarations, literal public/secret
values, reserved names, duplicate keys, setup/worker environment selection,
credential withholding, file permissions, owner/config binding and unsafe
cache rejection. A real shell exercises failure and process-group deadlines;
a stub CLI exercises the actual Claude runner's environment. Controller
scenarios consume preparation questions as owner-bound result artifacts
without another build. Free-form result reasons are withheld from the ledger
when either setup or worker secrets are declared; only the fixed missing-secret
diagnostic for a pinned, declared public name is reconstructed. Worker export
scenarios redact selected values from both phases. Workflow-shape checks keep the bundle before project
checkout, out of clean jobs, and outside result paths. These tests establish
local adapter behavior, not live Actions secret masking, Crew cleanup or
isolation between processes in the same worker job; sandbox validation remains.

Runtime isolation from agent-ready is outside Quint's one-runtime assumption.
Adapter/controller scenarios block enabled or unknown legacy workflows,
disabled workflows with live runs, incomplete counts and read failures.
Read-only discovery remains available. Worker phase checks, publisher and API
intent guards withhold new effects without inventing an uncertain submission.
The GitHub reader uses all five nonterminal status filters and authoritative
zero counts, avoiding a scan of completed history. These checks do not make
administrator workflow changes atomic with a publish request, establish sole
use of the App credential, or replace live migration validation.

Bootstrap and App inspection are outside the model. JavaScript scenarios and
an actual controller subprocess validate manual owner/default-branch/run
identity, GET-only App inspection, public-field selection and the absence of
token minting, state access or worker output. Bootstrap CLI preview runs
without local App credentials or mutations; publishing scenarios restrict it
to the pinned read-only caller/config and recover a lost PR response. The
shared job filters controller completion wake-ups before allocating a runner;
unit/workflow-shape checks cover that filter, not worker completion delivery.
Owner-only inspection and authenticated artifact consumption passed the live
check recorded above; App-backed mutations and worker recovery remain unverified.

Legacy migration is also outside the fixed-admission, fixed-PR model. The
manual default-branch request produces a read-only inventory, then requires
explicit mappings and the reviewed plan digest for import. Original admission,
PR ownership/head identity, closing references, configuration, conversation
and protected state are reobserved. A trusted operator's explicit cutover
retains legacy commands as history, preserves merged outcomes and records
pauses or questions without allocating an operation. Existing factory history
is preserved; uncertain legacy ownership is not reconstructed from PR prose.
Existing App stacks retain off-default bases in their snapshots and import
as questions rather than requiring a retarget before they can be represented.
An explicit pause remains paused; actual merged bases do not certify default
landing. Stack import, stale-base plans and unsupported-command consumption
have JavaScript regressions; bottom-up stack execution remains unavailable.
Migration and entry-process scenarios cover stale facts, state conflicts,
response loss, legacy isolation, human PR maintenance, provenance and the
absence of worker outputs. The entry process requests only contents write
access for import. Worker scenarios distinguish retained legacy commands from
new instructions, and status reports keep legacy usage unmeasured. These are
local adapter checks; actual state permissions, cutover and subsequent work
still require sandbox validation. See [migration usage](../factory/MIGRATION.md).
Activation also checks open legacy-labeled issues whose PR may already be
closed; a missing record or incomplete inventory withholds activation.
The closing-reference reader has complete-pagination and exact-head scenarios.
Its live sandbox probe could not authenticate: local `gh` credentials were
rejected with HTTP 401. This supplies no positive live evidence for that reader.
