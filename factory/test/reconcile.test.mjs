import { test } from "node:test";
import assert from "node:assert/strict";
import { decideItem } from "../lib/reconcile.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, step, reserve, claimed, ready, pending, run, observation, B, C, D, at, operation, proposal, artifact } from "./fixtures.mjs";
import { ingestCommands, resolveRoute } from "../lib/commands.mjs";
const config = parseConfig("trusted-users: [ntodd]");
const pr = (extra = {}) => ({ number: 9, state: "open", headSha: B, baseSha: "a".repeat(40), mergeable: "MERGEABLE", behind: false,
  checks: { state: "success", headSha: B, failed: [] }, ...extra });
const facts = (extra = {}) => ({ authorization: observation.authorization, issueState: "open", prs: [pr(), pr({ number: 10, state: "merged", mergedSha: C })], ...extra });
function decide(s = initial(), f = facts(), now = at, options = {}) { return decideItem(s, "issue:7", f, config, { now, ...options }); }
const apply = (s, plan) => plan.events.reduce((x, e) => step(x, e), s);

test("explicit respond cannot exceed the response-round limit", () => {
  const state = ready();
  operation(state).phase = "failed";
  const requested = ingestCommands(state, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 9, command: { action: "respond", text: "" } }]);
  const plan = decideItem(requested, "issue:7", facts(), { ...config, maxRounds: 1 }, { now: at });
  assert.equal(plan.action.type, "ask");
  assert.equal(plan.action.reason, "The response-round limit was reached");
  assert.equal(plan.events.some((e) => e.type === "reserve"), false);
});

test("terminal PR facts are recorded before deciding and a lower merge cannot hide unfinished work", () => {
  const plan = decide(initial(), facts({ prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10 })] }));
  assert.equal(plan.action.type, "handover");
  assert.equal(plan.action.pr, 10);
  assert.equal(apply(initial(), plan).items["issue:7"].complete, false);
  const done = decide(initial(), facts({ prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10, state: "merged", mergedSha: D })] }));
  assert.equal(done.action.type, "close-out");
  assert.equal(apply(initial(), done).items["issue:7"].complete, true);
});

test("pending publishes are reconciled while paused or after authority is lost", () => {
  const s = step(pending(), { type: "stop" });
  assert.equal(decide(s, facts({ authorization: { valid: false } })).action.type, "publish");
});

test("an uncertain publish becomes one request-bound question while recovery retains ownership", () => {
  let state = pending();
  const early = decide(state, facts(), "2026-11-12T12:10:00Z");
  assert.equal(early.status.state, "agent-working");
  assert.equal(early.status.wait.deadline, "2026-11-12T12:15:00.000Z");
  const late = decide(state, facts(), "2026-11-12T12:16:00Z"); state = apply(state, late);
  const question = state.items["issue:7"].question;
  assert.equal(question.kind, "publish-outcome"); assert.equal(question.recovery.request, "op-1/push/1");
  assert.equal(late.action.type, "publish"); assert.equal(late.status.state, "agent-needs-you");
  assert.equal(operation(state).phase, "publishing");
  state = ingestCommands(state, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: "2026-11-12T12:17:00Z", target: 9, command: { action: "retry", text: "" } }]);
  state = apply(state, decide(state, facts(), "2026-11-12T12:18:00Z"));
  assert.equal(state.items["issue:7"].question.id, question.id);
  assert.equal(operation(state).effects[0].requests.length, 1);
});

test("a legacy publication gets a recorded deadline without counting old worker time as publish time", () => {
  let state = step(ready(), { type: "authorize-publish", observation }); delete operation(state).publishStartedAt;
  state = apply(state, decide(state, facts(), "2026-11-12T14:00:00Z"));
  assert.equal(operation(state).publishStartedAt, "2026-11-12T14:00:00Z");
  assert.equal(state.items["issue:7"].question, null);
  state = apply(state, decide(state, facts(), "2026-11-12T14:16:00Z"));
  assert.match(state.items["issue:7"].question.reason, /before its deadline/);
});

test("queued ownership is preserved and timeout requests cancellation before a replacement", () => {
  const f = facts({ owner: { ...run, status: "queued", conclusion: null } });
  assert.equal(decide(claimed(), f).action, null);
  assert.equal(decide(claimed(), f, "2026-11-12T13:00:00Z").action.type, "cancel-owner");
  assert.equal(decide(claimed(), facts({ owner: null })).action, null);
  assert.equal(decide(claimed(), facts({ owner: { id: "999", attempt: 1, status: "completed" } })).action, null);
});

test("explicit retry retires an exhausted unclaimed operation exactly once", () => {
  let state = step(initial(), reserve());
  for (const date of [at, "2026-11-12T12:05:00Z", "2026-11-12T12:10:00Z"]) state = step(state, { type: "dispatch-request", at: date });
  state = apply(state, decide(state, facts(), "2026-11-12T12:20:00Z"));
  state = ingestCommands(state, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:997", revision: "e".repeat(64),
    author: "ntodd", createdAt: "2026-11-12T12:21:00Z", target: 9, command: { action: "retry", text: "" } }]);
  const retry = decide(state, facts(), "2026-11-12T12:22:00Z");
  assert.equal(retry.action.type, "reserve");
  state = apply(state, retry);
  assert.equal(operation(state).phase, "superseded");
  assert.throws(() => step(state, { type: "claim", run, provenance: { repositoryId: "42", workflowPath: ".github/workflows/factory.yml", headSha: "a".repeat(40) }, observation }), (e) => e.code === "claimed");
  state = step(state, reserve("op-2", { automatic: false, commandIds: retry.action.commandIds, at: "2026-11-12T12:22:00Z" }));
  const next = decide(state, facts(), "2026-11-12T12:23:00Z");
  assert.equal(next.action.type, "dispatch");
  assert.equal(next.action.operationId, "op-2");
  assert.equal(next.events.some((e) => e.type === "ask"), false);
  assert.equal(Object.keys(state.operations).length, 2);
});

test("cancellation and dispatch requests have durable bounded backoff", () => {
  let s = step(initial(), reserve());
  s = step(s, { type: "dispatch-request" });
  assert.equal(decide(s, facts(), "2026-11-12T12:01:00Z").action, null);
  for (const date of ["2026-11-12T12:05:00Z", "2026-11-12T12:10:00Z"]) s = step(s, { type: "dispatch-request", at: date });
  assert.equal(decide(s, facts(), "2026-11-12T12:20:00Z").status.state, "agent-failed");
  assert.throws(() => step(s, { type: "dispatch-request", at: "2026-11-12T12:25:00Z" }), (e) => e.code === "budget");
});

test("terminal worker status is committed before artifact acceptance; unknown results do not mean absent", () => {
  const f = facts({ owner: { ...run, status: "completed", conclusion: "success" }, result: { available: true, inspected: true } });
  const plan = decide(claimed(), f);
  assert.equal(plan.action.type, "collect-result");
  assert.equal(apply(claimed(), plan).operations["op-1"].owner.status, "completed");
  assert.equal(decide(claimed(), { ...f, result: {} }).action, null);
  assert.equal(decide(claimed(), { ...f, result: { inspected: true, available: false } }).action.type, "recover-worker");
});

test("obsolete heads and explicit stops cancel live owners and supersede terminal results", () => {
  const changed = facts({ prs: [pr({ headSha: D }), pr({ number: 10, state: "merged", mergedSha: C })], owner: { ...run, status: "in_progress", conclusion: null } });
  assert.equal(decide(claimed(), changed).action.type, "cancel-owner");
  assert.equal(decide(ready(), { ...changed, owner: { ...run, status: "completed", conclusion: "success" } }).action.type, "supersede");
  assert.equal(decide(step(ready(), { type: "stop" })).action.type, "supersede");
});

test("a user work command resumes an explicit pause and bypasses only the automatic quota", () => {
  let s = step(initial(), { type: "stop" });
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 9, command: { action: "respond", text: "fix the fixture" } }]);
  const plan = decide(s);
  assert.equal(plan.action.type, "reserve");
  assert.equal(plan.action.mode, "respond");
  assert.equal(plan.action.automatic, false);
  assert.equal(apply(s, plan).items["issue:7"].paused, false);
});

test("the same current-base failures wait, but mixed or weak attribution still responds", () => {
  const baseSha = "a".repeat(40), headSha = B;
  const failure = { signature: "test:Example.fails", sharedMain: true, baseSha };
  const f = facts({ main: { sha: baseSha, repairIssue: 30 }, prs: [pr({ checks: { state: "failure", headSha, failed: [failure] } })] });
  assert.equal(decide(initial(), f).status.wait.kind, "main-green");
  for (const failed of [[{ ...failure, signature: undefined }], [failure, { signature: "different test", sharedMain: false }]]) {
    assert.equal(decide(initial(), { ...f, prs: [pr({ checks: { state: "failure", headSha, failed } })] }).action.mode, "respond");
  }
});

test("unknown mergeability and old-head CI cannot trigger fixes or handover", () => {
  assert.equal(decide(initial(), facts({ prs: [pr({ mergeable: "UNKNOWN" })] })).action, null);
  assert.equal(decide(initial(), facts({ prs: [pr({ checks: { state: "failure", headSha: D, failed: [] } })] })).status.wait.kind, "ci");
});

test("CI waits preserve their deadline across passes and escalate instead of waiting forever", () => {
  const f = facts({ prs: [pr({ checks: { state: "pending", headSha: B } })] });
  const one = decide(initial(), f);
  const s = apply(initial(), one);
  const two = decide(s, f, "2026-11-12T12:30:00Z");
  assert.equal(two.status.wait.deadline, one.status.wait.deadline);
  assert.equal(decide(apply(s, two), f, "2026-11-12T13:01:00Z").action.type, "ask");
});

test("an identified transient failure gets one rerun; later failure responds", () => {
  const f = facts({ prs: [pr({ checks: { state: "failure", headSha: B, failed: [{ transient: true, runId: 123 }] } })] });
  assert.deepEqual(decide(initial(), f).action.runIds, [123]);
  assert.equal(decide(initial(), { ...f, prs: [{ ...f.prs[0], reruns: 1 }] }).action.mode, "respond");
});

test("old review state does not restart work after its revision was incorporated", () => {
  const feedback = [{ sourceId: "review:1", revision: "e".repeat(64), authority: "instruction", requiresResponse: true }];
  const f = facts({ prs: [pr({ feedback })] });
  const plan = decide(initial(), f);
  assert.equal(plan.action.mode, "respond");
  let s = step(initial(), reserve("op-1", { feedbackInputs: plan.action.feedbackInputs }));
  s = step(s, { type: "claim", run, provenance: { repositoryId: "42", workflowPath: ".github/workflows/factory.yml", headSha: "a".repeat(40) }, observation });
  s = step(s, { type: "owner-observed", run, status: "completed", conclusion: "success" });
  s = step(s, { type: "collect-result", artifact, proposal: { ...proposal, outcome: "no-change", effects: [] } });
  s = step(s, { type: "authorize-publish", observation });
  s = step(s, { type: "finish-publish" });
  assert.equal(decide(s, f).action.type, "handover");
  assert.equal(decide(s, { ...f, prs: [pr({ feedback: [{ ...feedback[0], revision: "f".repeat(64) }] })] }).action.mode, "respond");
});

test("serial integration only updates auto-merge PRs and waits for another selection", () => {
  const f = facts({ prs: [pr({ behind: true, autoMerge: true })] });
  assert.equal(decide(initial(), f).action.mode, "update");
  assert.equal(decide(initial(), f, at, { integration: { item: "issue:8" } }).status.wait.kind, "integration");
  assert.equal(decide(initial(), facts({ prs: [pr({ behind: true, autoMerge: false })] })).action.type, "handover");
});

test("closing a required PR needs a question; successful own-PR work does not enroll ongoing maintenance", () => {
  assert.equal(decide(initial(), facts({ prs: [pr({ state: "closed" })] })).action.type, "ask");
  let s = ready();
  s.items["issue:7"].evidence.own = true;
  s = step(s, { type: "authorize-publish", observation });
  // no-change proposal completes with no push
  s.operations["op-1"].effects = [];
  s = step(s, { type: "finish-publish" });
  s = step(s, { type: "hand-over", number: 9, head: B });
  assert.equal(decide(s, facts({ prs: [pr({ mergeable: "CONFLICTING" })] })).action, null);
});

const answer = (s, text, id = 999, when = "2026-11-12T12:01:00Z") => ingestCommands(s, "issue:7", [{
  authority: "instruction", sourceId: `issue-comment:${id}`, revision: "e".repeat(64), author: "ntodd", createdAt: when,
  target: 7, command: { action: "answer", text },
}]);

test("a fresh closure answer records the disposition and completes only the accounted work", () => {
  const f = facts({ prs: [pr({ state: "closed" }), pr({ number: 10, state: "merged", mergedSha: C })] });
  let s = apply(initial(), decide(initial(), f));
  assert.equal(s.items["issue:7"].question.kind, "pr-closure");
  s = answer(s, "1");
  const plan = decide(s, f, "2026-11-12T12:02:00Z"), done = apply(s, plan);
  assert.equal(plan.action.type, "close-out");
  assert.equal(done.items["issue:7"].complete, true);
  assert.equal(done.items["issue:7"].prs[0].dispositionSource, "issue-comment:999");
  assert.equal(done.items["issue:7"].attempts.length, 0);
  assert.equal(done.items["issue:7"].prs[1].mergedSha, C);
});

test("routed numbered answers apply to the recorded PR or completion question without rewriting human text", () => {
  const closed = facts({ prs: [pr({ state: "closed" }), pr({ number: 10, state: "merged", mergedSha: C })] });
  const revised = facts({ authorization: { valid: true, revision: "f".repeat(64) },
    prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10, state: "merged", mergedSha: D })] });
  for (const f of [closed, revised]) {
    let s = apply(initial(), decide(initial(), f));
    s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
      author: "ntodd", createdAt: "2026-11-12T12:01:00Z", target: 7, command: { action: "route", text: "@ntodd-agent go with 1" } }]);
    const commandId = Object.keys(s.items["issue:7"].commands)[0];
    s = resolveRoute(s, "issue:7", commandId, "answer", null, { handle: "ntodd-agent" });
    const plan = decide(s, f, "2026-11-12T12:02:00Z"), done = apply(s, plan);
    assert.equal(plan.action.type, "close-out");
    assert.equal(done.items["issue:7"].complete, true);
    assert.equal(done.items["issue:7"].commands[commandId].text, "@ntodd-agent go with 1");
  }
});

test("one accepted closure cannot waive the other closed PRs or replay its answer", () => {
  const f = facts({ prs: [pr({ state: "closed" }), pr({ number: 10, state: "closed" })] });
  let s = apply(initial(), decide(initial(), f));
  s = apply(answer(s, "1"), decide(answer(s, "1"), f, "2026-11-12T12:02:00Z"));
  assert.equal(s.items["issue:7"].complete, false);
  assert.equal(s.items["issue:7"].question.number, 10);
  assert.equal(s.items["issue:7"].prs[0].acceptedClosure, true);
  assert.equal(s.items["issue:7"].prs[1].acceptedClosure, false);
  const repeated = apply(s, decide(s, f, "2026-11-12T12:03:00Z"));
  assert.equal(repeated.items["issue:7"].question.id, s.items["issue:7"].question.id);
});

test("an old numbered answer cannot waive changed requirements; unclear answers are consumed once", () => {
  const closed = facts({ prs: [pr({ state: "closed" }), pr({ number: 10, state: "merged", mergedSha: C })] });
  const asked = apply(initial(), decide(initial(), closed));
  for (const [text, fresh] of [["1", { ...closed, authorization: { valid: true, revision: "f".repeat(64) } }], ["maybe", closed],
    ["accept-closure #80", closed]]) {
    const requested = answer(asked, text);
    const result = apply(requested, decide(requested, fresh, "2026-11-12T12:02:00Z"));
    assert.equal(result.items["issue:7"].prs[0].acceptedClosure, false);
    assert.equal(result.items["issue:7"].question.kind, "pr-closure");
    assert.equal(Object.values(result.items["issue:7"].commands)[0].status, "applied");
    assert.equal(apply(result, decide(result, fresh)).items["issue:7"].question.id, result.items["issue:7"].question.id);
  }
});

test("closure acceptance requires a successful fresh observation and does not authorize an in-flight replacement", () => {
  const f = facts({ prs: [pr({ state: "closed" }), pr({ number: 10, state: "merged", mergedSha: C })] });
  const asked = apply(initial(), decide(initial(), f));
  const requested = answer(asked, "accept-closure #9");
  const unknown = decide(requested, { ...f, observationError: "incomplete observation" });
  assert.equal(unknown.action, null);
  assert.equal(apply(requested, unknown).items["issue:7"].prs[0].acceptedClosure, false);
  const lost = decide(requested, { ...f, authorization: { valid: false } });
  assert.equal(lost.action.type, "ask");
  assert.equal(apply(requested, lost).items["issue:7"].prs[0].acceptedClosure, false);
  const live = answer(pending(), "accept-closure #9");
  assert.equal(decide(live, f).action.type, "publish");
});

test("a valid edited issue revision invalidates an already accepted worker result", () => {
  const plan = decide(ready(), facts({ authorization: { valid: true, revision: "f".repeat(64) } }));
  assert.equal(plan.action.type, "supersede");
  assert.equal(apply(ready(), plan).items["issue:7"].generation, 1);
});

test("unknown check states cannot hand over a PR", () => {
  assert.equal(decide(initial(), facts({ prs: [pr({ checks: { state: "unexpected", headSha: B } })] })).action, null);
});


test("own-PR maintenance still waits for its CI before the authorized operation is handed back", () => {
  let s = ready(); s.items["issue:7"].evidence.own = true;
  s = step(s, { type: "authorize-publish", observation });
  s.operations["op-1"].effects = [];
  s = step(s, { type: "finish-publish" });
  const f = facts({ prs: [pr({ checks: { state: "failure", headSha: B, failed: [{ signature: "new integration failure" }] } })] });
  assert.equal(decide(s, f).action.mode, "respond");
  s = step(s, { type: "hand-over", number: 9, head: B });
  assert.equal(decide(s, f).action, null);
});

test("own PRs cannot be restarted or enrolled by an unsupported command", () => {
  let s = initial(); s.items["issue:7"].evidence.own = true;
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 9, command: { action: "restart", text: "" } }]);
  const plan = decide(s);
  assert.equal(plan.action.type, "ask");
  assert.match(plan.status.reason, /cannot be restarted/);
});

test("edited changes-requested review text becomes an explicit question rather than silent handover", () => {
  const plan = decide(initial(), facts({ prs: [pr({ feedback: [{ sourceId: "review:5", trustedAuthor: true, edited: true, requiresResponse: true, authority: "data" }] })] }));
  assert.equal(plan.action.type, "ask");
});

test("a prepared operation is superseded when main changes before default-branch dispatch", () => {
  const s = step(initial(), reserve());
  assert.equal(decide(s, facts({ main: { sha: D } })).action.type, "supersede");
});

test("a conflicted clean update becomes resolve instead of retrying the same failed merge forever", () => {
  const s = ready();
  const op = operation(s); op.mode = "update"; op.phase = "failed"; op.result.outcome = "failed"; op.failure = "update-conflict";
  s.items["issue:7"].attempts[0].kind = "api";
  assert.equal(decide(s).action.mode, "resolve");
});

test("a merge while publication is uncertain still recovers its effect before issue close-out", () => {
  const s = pending();
  const f = facts({ prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10, state: "merged", mergedSha: D })] });
  const first = decide(s, f);
  assert.equal(first.action.type, "publish");
  let recovered = apply(s, first);
  assert.equal(recovered.items["issue:7"].complete, false);
  recovered = step(recovered, { type: "effect-observed", effectId: "push", requestId: "op-1/push/1", outcome: "applied", evidence: { kind: "branch-head", commit: C } });
  recovered = step(recovered, { type: "finish-publish" });
  assert.equal(decide(recovered, f).action.type, "close-out");
});

test("a revised issue cannot close on PRs for its previous accepted revision without an explicit decision", () => {
  const f = facts({ authorization: { valid: true, revision: "f".repeat(64) }, prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10, state: "merged", mergedSha: D })] });
  const first = decide(initial(), f);
  assert.equal(first.action.type, "ask");
  let s = apply(initial(), first);
  assert.equal(s.items["issue:7"].complete, false);
  assert.equal(s.items["issue:7"].question.kind, "completion-revision");
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: "2026-11-12T12:01:00Z", target: 9, command: { action: "answer", text: "accept-completion" } }]);
  const accepted = decide(s, f, "2026-11-12T12:02:00Z");
  assert.equal(accepted.action.type, "close-out");
  const done = apply(s, accepted);
  assert.equal(done.items["issue:7"].revision, "f".repeat(64));
  assert.equal(done.items["issue:7"].completionAcceptance.sourceId, "issue-comment:999");
});

test("an unclear completion answer is consumed once rather than producing a question every pass", () => {
  const f = facts({ authorization: { valid: true, revision: "f".repeat(64) }, prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10, state: "merged", mergedSha: D })] });
  let s = apply(initial(), decide(initial(), f));
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 9, command: { action: "answer", text: "maybe" } }]);
  const asked = apply(s, decide(s, f)), again = apply(asked, decide(asked, f));
  assert.equal(asked.items["issue:7"].question.id, again.items["issue:7"].question.id);
  assert.equal(Object.values(again.items["issue:7"].commands)[0].status, "applied");
});

test("a draft waiting on configured review bots is marked ready after CI without handing it to a human early", () => {
  const plan = decide(initial(), facts({ prs: [pr({ draft: true, signals: { pending: ["review:review-bot"] } })] }));
  assert.equal(plan.action.type, "ready-for-bots");
  assert.equal(plan.status.state, "agent-waiting");
});

test("a revised issue with an existing green PR starts a response on that PR before another hand-over", () => {
  const plan = decide(initial(), facts({ authorization: { valid: true, revision: "f".repeat(64) } }));
  assert.equal(plan.action.type, "reserve");
  assert.equal(plan.action.mode, "respond");
  assert.equal(plan.action.pr, 9);
  assert.equal(apply(initial(), plan).items["issue:7"].revisionPending, true);
});

test("a revision pending when its PR merges requires explicit completion acceptance", () => {
  const authorization = { valid: true, revision: "f".repeat(64) };
  const response = decide(initial(), facts({ authorization }));
  let state = apply(initial(), response);
  state = step(state, reserve("op-1", { revision: authorization.revision }));
  const merged = facts({ authorization, prs: [pr({ state: "merged", mergedSha: C }), pr({ number: 10, state: "merged", mergedSha: C })] });
  state = apply(state, decide(state, merged));
  state = step(state, { type: "supersede", observation: { open: false } });
  const plan = decide(state, merged);
  assert.equal(plan.action.type, "ask");
  state = apply(state, plan);
  assert.equal(state.items["issue:7"].question.kind, "completion-revision");
  assert.throws(() => step(state, { type: "close-out" }), (e) => e.code === "incomplete");
  state = ingestCommands(state, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:998", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 9, command: { action: "answer", text: "accept-completion" } }]);
  const accepted = decide(state, merged);
  assert.equal(accepted.action.type, "close-out");
  state = apply(state, accepted);
  assert.equal(state.items["issue:7"].complete, true);
  assert.equal(state.items["issue:7"].revisionPending, false);
});

test("a reserved CI rerun is recovered before code repair and a queued rerun releases all workers", () => {
  const rerun = { effectId: "e".repeat(64), effectStatus: "pending", requestedAttempt: 1, attempt: 1, status: "completed", createdAt: at, requests: 1 };
  const current = pr({ checks: { state: "failure", headSha: B, failed: [{ transient: true, runId: 123 }] }, reruns: 1, apiReruns: [rerun] });
  assert.equal(decide(initial(), facts({ prs: [current] })).action.type, "recover-ci");
  current.apiReruns = [{ ...rerun, effectStatus: "applied", attempt: 2, status: "queued" }];
  const waiting = decide(initial(), facts({ prs: [current] }));
  assert.equal(waiting.action, null); assert.equal(waiting.status.wait.kind, "ci-rerun");
  current.apiReruns[0].status = "completed";
  assert.equal(decide(initial(), facts({ prs: [current] })).action.mode, "respond");
  current.apiReruns[0].status = "queued";
  assert.equal(decide(initial(), facts({ prs: [current] }), "2026-11-12T13:01:00Z").action.type, "ask");
});
