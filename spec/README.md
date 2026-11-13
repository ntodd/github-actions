# Factory model

`factory.qnt` models the ownership and publishing protocol in
[DESIGN.md](../DESIGN.md). `scheduling.qnt` models the controller queue,
event filters and recovery of worker deliveries before claim.
Both use Quint's lightweight Rust simulator;
there is no JVM, TLC, Apalache or running service required.
The [conformance audit](CONFORMANCE.md) maps modeled contracts to scenarios
and lists every abstraction boundary. The full design is not modeled.

## Run it

```sh
npm ci --ignore-scripts
npm run model:check
npm run model:simulate
npm run model:replay
```

Quint is pinned in `package-lock.json`. The CLI fetches its matching Rust
evaluator on first use. Set `QUINT_HOME` if its cache should live elsewhere.
All three simulation profiles explicitly select `--backend=rust`, a fixed seed,
one thread, 10,000 samples each and 100 steps per sample. The hostile profile
changes inputs and stops workers; the recovery profile keeps inputs stable
while retaining duplicate deliveries and publisher crashes. The scheduling
profile explores lost requests, pending-job replacement, controller crashes,
filtered events, dispatch backoff and result collection. A seed does not
replace `--max-samples`: without that option Quint runs only one seeded sample.

To explore another seed or save a trace:

```sh
mkdir -p spec/traces
npm run model:chaos -- --seed=42 --out-itf=spec/traces/chaos.itf.json
npm run model:recovery -- --seed=42 --out-itf=spec/traces/recovery.itf.json
```

Keep the Quint/evaluator versions, seed, thread count and limits when
reproducing a failure. Reduce its trace into a named scenario test before
changing the protocol. Witness counts show whether exploration reached
interesting states; zero hits are a coverage gap, not a successful check.

## Scope

The model starts with one admitted issue and two known, required PRs. It
allows three automatic attempts in one budget window, duplicate and delayed
dispatches, queued/running workers, crashes, stale or expired results,
stop/resume, human pushes, main changes, CI observations, approval and merge.
Run IDs stand for the full `(run_id, run_attempt)` identity in the design.

The publisher separates authorization, request submission, remote
application and receipt persistence. A submitted request can finish after
the publisher crashes or stop is acknowledged. Stop forbids new requests;
it cannot retract one already sent. An unchanged branch head does not
establish that a timed-out request failed. Recovery waits for a known
outcome before replacing the operation.

`applied` abstracts querying remote commit history; it is not another local
receipt. `pending` represents an uncertain request. The model only returns
to retry after a definitive rejection or a known absence of submission.
A human push can race with the publisher even while it owns the controller
lock. Main can also move independently; only the PR head is guarded at the
remote write. Current integration and approval are enforced at merge time.

Worker completion produces an artifact and releases Crew. It does not
advance the durable phase. A controller transition accepts an artifact only
from the recorded operation and run/attempt, then advances to `result-ready`.

The invariants check:

- at most one live owner per issue, including queued workers
- bounded automatic attempts
- publish requests match the current generation, expected head and result owner
- delayed remote writes cannot overwrite a changed PR head
- unresolved requests remain attached to their original operation
- accepted artifacts match the recorded operation and owner
- no duplicate pushes, and no receipt without an external effect
- merged commits have matching approval, CI and integrated base
- an issue completes only after both required PRs merge
- workers release Crew while external work is pending

Named tests cover successful completion as well as blocked actions and
recovery. Random traces add reordering and adverse timing. Safety checks
are complemented by witnesses for duplicate delivery, recovery after a
push, stale observations, stop with a live owner, budget exhaustion,
partial/full completion, expired artifacts, late writes after stop and
main changes during publication.

## Limits and assumptions

The scheduling model starts with one reserved operation and explicitly
represents Actions' `queue: max`: one running and up to 100 pending control
jobs, ordered by admission to the concurrency group. A full queue rejects the
new arrival and preserves existing jobs. Named scenarios retain four worker
deliveries and exercise overflow; those additional jobs are opaque queue
entries, not four modeled operation lifecycles. The factory App's status
surfaces and non-worker completions are filtered before queue admission.
Lost or canceled deliveries retain their reservation, redispatch uses the same
operation, and three exhausted requests lead to a question. A scheduled
backstop can also collect a result whose completion wake-up was lost.

Acknowledged dispatches retain their run ID and original reservation queue
deadline. A fresh observation of that run waiting or running prevents another
dispatch request, even after the ordinary backoff or third request. The receipt
does not claim ownership. Thirty minutes is six modeled five-minute ticks;
expiry asks, and an explicit retry can retire the still-unclaimed reservation
and fence its late delivery. Unknown responses retain the bounded redispatch
path. The additional named scenarios and replay exercise these distinct cases.

Scheduling replay executes the actual generated callers' job filters,
subscriptions and run-name expression, the shared control filter and the
in-code completion guard. It checks the configured queue policy and each queue
transition, and dispatch/collection decisions against
`decideItem` and phase, owner, request count and questions against `evolve`.
It covers twelve event classes, not every GitHub payload or reconciler branch.
Queue behavior is an explicit platform assumption from GitHub's documented policy;
Quint cannot establish what GitHub actually delivers. Runner isolation, REST
response shapes, permissions, rate-limit headers and immutable-object cache
correctness remain adapter and live tests.

This is sampled exploration of a design, not exhaustive verification or a
test of the current JavaScript implementation. It does not prove liveness:
random exploration may stop making progress forever. Progress requires
working services, delivered wake-ups, stable inputs and human decisions.
Named completion scenarios show possible progress, not inevitable progress.

The model assumes GitHub enforces the controller mutex, atomic guarded
PR-head updates and merge protections. It assumes no transaction across
main, the PR branch and the ledger. In particular, the merge guard models
the desired latest-push approval rule; sandbox tests must establish the real
behavior. API reads abstract an authoritative observation, not arbitrary
stale replicas. The publisher's expected-head write must enforce that
precondition on the server, not rely on an earlier read.

It omits admission/authentication, command ingestion, multiple issues,
branch/PR creation, comments, ledger Git conflicts, notifications, detailed
failure classification, cost accounting, budget-window rollover, explicit
budget overrides, manual rerun APIs, accepted closure/waiver and stack
dependency ordering. The two PRs exercise aggregate completion; they are not a full stack model. A queued
attempt conservatively consumes a reservation here, even if it never starts.
Session restoration is outside the model; missing result data means retry
on the same work item. Extend the model as each omitted contract is built.

Keep GitHub sandbox tests for protections, identity, artifact provenance,
event delivery, actual compare-and-update behavior and approval semantics.
The replay command runs named Quint scenarios and sampled traces through
the real operation protocol and compares its durable state projection at
every step. Scheduling traces additionally check workflow routing and the
dispatch/collection decision table. This establishes correspondence for those
contracts, not the full reconciler or live GitHub API adapters.
