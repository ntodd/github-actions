# Design and model conformance

This is a manual semantic audit of [DESIGN.md](../DESIGN.md) against
[factory.qnt](factory.qnt), not a proof that the two are equivalent.
The model covers a bounded ownership and publishing protocol within the
design. It does not model the entire issue-handling system.

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
| A late push to an already-merged PR branch is not the commit that landed | `merge`, `applyPush`; immutable `merges` history | `mergeWhilePushInFlightTest` |
| [PR and issue state](../DESIGN.md#states-and-where-you-see-them): merging one required PR does not complete all work | `merge`, `closeOut`; `completeMeansAllMerged` | `partialCompletionTest`, `fullCompletionTest` |

## Abstraction boundaries and assumptions

| Design area | What the model does | What it does not establish |
| --- | --- | --- |
| Accepted issues and PR membership | Starts with one authorized issue and two known required PRs | Admission, content revisions, grouped-issue authority, PR creation, membership changes |
| Durable Git ledger | State transitions stand for successful atomic ledger transactions; the long publisher lock is explicit | Git ref conflicts, schema migration, missing/corrupt state, real branch protections or storage durability |
| Controller serialization | An unlocked controller action executes atomically; other controller actions wait while `locked` | Actual Actions concurrency semantics, multiple repositories/items, pending-job replacement or discovery of lost commands |
| Run identity and artifact provenance | `(operation, runId)` represents a unique operation and complete run/attempt identity | GitHub identity authentication, artifact digests, schema/content validation, token isolation or forged API responses |
| Publishing | One proposed commit and one branch effect per operation; no force pushes; an uncertain remote request remains pending | Multi-effect publishes, comment/PR deduplication, attachments, branch creation, repository hooks, actual API consistency |
| Expected-head update | `applyPush` atomically checks the PR head; main and ledger are separate | That a chosen GitHub adapter implements this guard correctly; sandbox tests must establish it |
| Ambiguous remote outcomes | `pending` includes a sent request or an intent whose submission/outcome is unknown; `rejectPush` supplies definitive no-effect evidence | A timeout or an unchanged branch is not modeled as rejection. If real APIs cannot resolve uncertainty, the design must escalate rather than assume this transition is available |
| Retry budget | Three reservations in one window, including queued attempts; redispatch spends no extra reservation | UTC rollover, explicit human overrides, repeated-failure thresholds, round limits, cost caps and API retry budgets |
| Reconciler scheduling | `step` nondeterministically selects protocol operations; `recoveryStep` explores stable-input recovery | The design's full first-applicable-action ordering, reasons for new work, fairness, serial integration selection, priority and deadlines |
| Main health, CI and review | Exact numeric head/base identities and successful CI observations; approval is attached to a head | CI failures, flaky reruns, failure matching, main repair dependencies, review threads, bot policies, review dismissal/revocation and signal timeouts |
| Merge policy | `merge` represents a human-authorized GitHub merge with strict approval/check guards | Automatic merge is not an App action here. The model does not track enabling auto-merge, admin bypass, GitHub's actual approval implementation or queued merge behavior |
| Completion | Both fixed required PRs must merge; merged commit identity stays in the audit history | Accepted closure/waiver, replacement PRs, abandoned issues, reopening or stack base dependencies. Those are explicitly allowed by the design but outside this model |
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
   owner, generation, budget, expected commits and aggregate completion at
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

Config parsing uses a pinned bundled YAML parser, regenerated and checked
against its source by the build scripts. GitHub read queries have also been
accepted by the live API for this repository's issue/PR edit history,
reviews and thread lists. Large nested pagination is exercised by API fakes;
production artifact, token, worker, publish and event-delivery checks remain
part of the sandbox rollout.

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
without another build. Workflow-shape checks keep the bundle before project
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
