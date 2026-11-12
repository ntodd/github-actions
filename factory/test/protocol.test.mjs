import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, emptyLedger, evolve, validateLedger, revisionOf, validBranch } from "../lib/protocol.mjs";
import { ingestCommands } from "../lib/commands.mjs";
import { A, B, C, D, at, run, provenance, revision, observation, reserve, artifact, proposal,
  initial, step, operation, claimed, ready, publishing, pending } from "./fixtures.mjs";
const fails = (fn, code) => assert.throws(fn, (e) => e.code === code);
const observed = (s, outcome, evidence, extra = {}) => step(s, { type: "effect-observed", effectId: "push",
  requestId: "op-1/push/1", outcome, evidence, ...extra });

test("operation targets must belong to their item and PR membership is repository-wide", () => {
  const state = step(initial(), reserve());
  operation(state).target.number = 99;
  fails(() => validateLedger(state), "corrupt");
  const duplicate = initial();
  duplicate.items["issue:8"] = { ...structuredClone(duplicate.items["issue:7"]), key: "issue:8" };
  fails(() => validateLedger(duplicate), "corrupt");
});

test("prepared abandonment requires exhausted dispatch, an explicit request and zero ownership", () => {
  let s = ingestCommands(step(initial(), reserve()), "issue:7", [{ authority: "instruction", sourceId: "issue-comment:997", revision,
    author: "ntodd", createdAt: at, target: 9, command: { action: "retry", text: "" } }]);
  const commandId = Object.keys(s.items["issue:7"].commands)[0], event = { type: "abandon-prepared", commandId };
  fails(() => step(s, event), "invalid");
  for (const date of [at, "2026-11-12T12:05:00Z", "2026-11-12T12:10:00Z"]) s = step(s, { type: "dispatch-request", at: date });
  fails(() => step(step(s, { type: "claim", run, provenance, observation }), event), "busy");
  const abandoned = step(s, event);
  assert.equal(operation(abandoned).phase, "superseded");
  operation(abandoned).abandonedPrepared.commandId = "missing";
  fails(() => validateLedger(abandoned), "corrupt");
});

test("configured check findings are valid operation inputs, while arbitrary feedback kinds are rejected", () => {
  const input = { sourceId: "check:123", revision: "e".repeat(64) };
  assert.equal(step(initial(), reserve("op-1", { feedbackInputs: [input] })).operations["op-1"].feedbackInputs[0].sourceId, "check:123");
  fails(() => step(initial(), reserve("op-1", { feedbackInputs: [{ ...input, sourceId: "unknown:123" }] })), "corrupt");
});

test("continuing a closed issue needs a current decision and known reopening before another worker", () => {
  let s = step(initial(), { type: "ask", kind: "issue-closure", reason: "Stop or continue?" });
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64), author: "ntodd",
    createdAt: at, target: 7, command: { action: "answer", text: "continue" } }]);
  const commandId = Object.keys(s.items["issue:7"].commands)[0], answer = { type: "answer-issue-closure", commandId, decision: "continue" };
  fails(() => step(s, answer), "invalid");
  s = step(s, { ...answer, authorization: observation.authorization });
  fails(() => step(s, reserve()), "waiting");
  fails(() => step(s, { type: "finish-continuation", commandId, issueOpen: true }), "pending");
  const corrupt = structuredClone(s); corrupt.items["issue:7"].continuation.phase = "done";
  assert.throws(() => validateLedger(corrupt), /known reopen outcome/);
  assert.equal(s.items["issue:7"].attempts.length, 0);
});

test("only known changes settle a main dependency question, without clearing another decision or a pause", () => {
  const green = { type: "resolve-main-question", outcome: "main-green", main: { sha: A, checks: { headSha: A, state: "success" } } };
  fails(() => step(step(initial(), { type: "ask", reason: "Choose the product behavior" }), green), "pending");
  const asked = step(initial(), { type: "ask", kind: "main-failure", reason: "Admit a main repair", dependency: {
    baseSha: A, pr: 9, headSha: B, keys: ["f".repeat(64)], repairIssue: null,
  } });
  fails(() => step(asked, { ...green, main: { sha: A, checks: { headSha: B, state: "success" } } }), "pending");
  fails(() => step(asked, { ...green, main: { sha: A, checks: { headSha: A, state: "pending" } } }), "pending");
  fails(() => step(asked, { type: "resolve-main-question", outcome: "repair-admitted", repairKey: "issue:7", repairBase: A,
    repairAuthorization: observation.authorization }), "pending");
  const settled = step(step(asked, { type: "stop" }), green);
  assert.equal(settled.items["issue:7"].question, null); assert.equal(settled.items["issue:7"].paused, true);
});

test("admission is stable and fingerprints issue content independently of metadata", () => {
  const s = initial();
  assert.strictEqual(admit(s, { key: "issue:7", revision, evidence: { sourceId: "label:999" } }), s);
  assert.equal(revisionOf({ title: "x", body: "y", updated_at: 1 }), revisionOf({ title: "x", body: "y", updated_at: 2 }));
  assert.notEqual(revisionOf({ title: "x", body: "y" }), revisionOf({ title: "x", body: "z" }));
});

test("only an exact observed publish outcome can clear its recovery question", () => {
  const event = { type: "ask", kind: "publish-outcome", reason: "Investigate the pending request", at,
    recovery: { operation: "op-1", effect: "push", request: "op-1/push/1" } };
  let state = step(pending(), event);
  fails(() => step(state, { type: "resolve-publish-question" }), "pending");
  assert.equal(step(state, { type: "resume", answerSource: "issue-comment:99" }).items["issue:7"].question.id, state.items["issue:7"].question.id);
  fails(() => step(pending(), { ...event, recovery: { ...event.recovery, request: "op-1/push/2" } }), "invalid");
  state = step(state, { type: "stop" });
  state = observed(state, "applied", { kind: "branch-head", commit: C });
  state = step(state, { type: "resolve-publish-question" });
  assert.equal(state.items["issue:7"].question, null); assert.equal(state.items["issue:7"].paused, true);
  assert.equal(state.items["issue:7"].lastQuestion.resolution, "publish-outcome-observed");
});

test("sent publish/API requests cannot be disguised as prepared records", () => {
  const state = pending(); operation(state).effects[0].status = "prepared";
  fails(() => validateLedger(state), "corrupt");
});

test("a pending mention record cannot reserve work, restart, or accept unrelated admission evidence", () => {
  const s = admit(emptyLedger("42"), { key: "issue:7", revision, requestOnly: true,
    evidence: { kind: "request", sourceId: "issue-comment:99", revision: "e".repeat(64), actor: "ntodd" } });
  fails(() => step(s, reserve()), "waiting");
  fails(() => step(s, { type: "begin-restart", commandId: "unknown" }), "invalid");
  fails(() => step(s, { type: "admit-request", commandId: "unknown", authorization: observation.authorization }), "invalid");
  const corrupt = structuredClone(s); corrupt.items["issue:7"].requestOnly = false;
  fails(() => validateLedger(corrupt), "corrupt");
});

test("reservation is durable and delivery cannot double-charge or claim a second owner", () => {
  const s = claimed();
  assert.deepEqual(step(s, reserve()), s);
  assert.equal(s.items["issue:7"].attempts.length, 1);
  assert.deepEqual(step(s, { type: "claim", run, provenance, observation }), s);
  fails(() => step(s, { type: "claim", run: { ...run, id: "101" }, provenance, observation }), "claimed");
  fails(() => step(s, reserve("op-2")), "busy");
});

test("claim checks fresh authority, head and default-branch workflow provenance", () => {
  const s = step(initial(), reserve());
  for (const change of [{ authorization: { valid: false } }, { head: D }, { open: false }]) {
    fails(() => step(s, { type: "claim", run, provenance, observation: { ...observation, ...change } }), "stale");
  }
  fails(() => step(s, { type: "claim", run, provenance: { ...provenance, headSha: D }, observation }), "provenance");
  assert.equal(operation(s).phase, "prepared");
});

test("queued and unknown owners remain owned; only confirmed terminal owners can fail", () => {
  const s = claimed();
  fails(() => step(s, { type: "recover-worker", resultAbsent: true }), "busy");
  fails(() => step(s, { type: "owner-observed", run: { ...run, attempt: 2 }, status: "completed", conclusion: "failure" }), "stale");
  let terminal = step(s, { type: "owner-observed", run, status: "completed", conclusion: "cancelled" });
  fails(() => step(terminal, { type: "owner-observed", run, status: "in_progress" }), "stale");
  fails(() => step(terminal, { type: "recover-worker" }), "unknown");
  terminal = step(terminal, { type: "recover-worker", resultAbsent: true });
  const retry = step(terminal, reserve("op-2"));
  assert.equal(operation(retry).phase, "prepared");
  fails(() => step(retry, { type: "claim", operationId: "op-1", run, provenance, observation }), "stale");
});

test("result acceptance needs terminal ownership and matching artifact provenance", () => {
  fails(() => step(claimed(), { type: "collect-result", proposal, artifact }), "busy");
  const terminal = step(claimed(), { type: "owner-observed", run, status: "completed", conclusion: "failure" });
  for (const change of [{ run: { ...run, attempt: 2 } }, { expired: true }, { repositoryId: "99" }, { headSha: D }, { digest: "bad" }]) {
    fails(() => step(terminal, { type: "collect-result", proposal, artifact: { ...artifact, ...change } }), "provenance");
  }
  const accepted = step(terminal, { type: "collect-result", proposal, artifact });
  assert.equal(operation(accepted).phase, "result-ready", "valid uploaded results survive a worker crash");
});

test("a proposal cannot select its own branch, base, owner or non-ready push", () => {
  const s = step(claimed(), { type: "owner-observed", run, status: "completed", conclusion: "success" });
  const altered = [
    { ...proposal, run: { ...run, attempt: 2 } },
    { ...proposal, outcome: "needs-you" },
    ...[{ branch: "main" }, { expectedHead: D }, { baseSha: D }].map((change) => ({ ...proposal, effects: [{ ...proposal.effects[0], ...change }] })),
  ];
  for (const p of altered) fails(() => step(s, { type: "collect-result", proposal: p, artifact }), "invalid-result");
});

test("stop and revised issues fence new requests, including after resume", () => {
  for (const event of [{ type: "stop" }, { type: "revise", revision: revisionOf({ title: "Changed task" }) }]) {
    const before = publishing();
    const s = step(before, event);
    fails(() => step(s, { type: "request-effect", effectId: "push", observation }), "stale");
    fails(() => step(step(s, { type: "resume" }), { type: "request-effect", effectId: "push", observation }), "stale");
    assert.equal(before.items["issue:7"].generation, 0, "transitions do not mutate prior snapshots");
  }
});

test("base is rechecked at authorization, but main may move before submission", () => {
  assert.equal(operation(step(ready(), { type: "authorize-publish", observation: { ...observation, baseSha: D } })).phase, "superseded");
  const s = step(publishing(), { type: "request-effect", effectId: "push", observation: { ...observation, baseSha: D } });
  assert.equal(operation(s).effects[0].status, "pending");
});

test("uncertain requests are neither retried nor replaced on timeout or absent effects", () => {
  const s = pending();
  assert.deepEqual(step(s, { type: "request-effect", effectId: "push", observation }), s);
  assert.deepEqual(observed(s, "unknown"), s);
  fails(() => observed(s, "rejected", { kind: "http-rejection", status: 500 }), "unknown");
  fails(() => observed(s, "applied", { kind: "branch-head", commit: D }), "unknown");
  fails(() => step(s, { type: "finish-publish" }), "pending");
  fails(() => step(step(s, { type: "stop" }), { type: "supersede" }), "pending");
  fails(() => step(s, reserve("op-2")), "busy");
});

test("an in-flight push can be reconciled after stop without resuming", () => {
  const stopped = step(pending(), { type: "stop" });
  const s = step(observed(stopped, "applied", { kind: "commit-ancestor", commit: C }), { type: "finish-publish" });
  assert.equal(operation(s).phase, "done");
  assert.equal(s.items["issue:7"].paused, true);
  assert.equal(operation(s).effects[0].requests.length, 1);
  assert.equal(operation(s).effects[0].receipt.commit, C);
});

test("definitive rejection permits bounded requests, but old responses cannot resolve a new request", () => {
  let s = observed(pending(), "rejected", { kind: "http-rejection", status: 422 });
  s = step(s, { type: "request-effect", effectId: "push", observation });
  fails(() => observed(s, "applied", { kind: "branch-head", commit: C }), "stale");
  for (const n of [2, 3]) {
    s = observed(s, "rejected", { kind: "http-rejection", status: 422 }, { requestId: `op-1/push/${n}` });
    if (n < 3) s = step(s, { type: "request-effect", effectId: "push", observation });
  }
  fails(() => step(s, { type: "request-effect", effectId: "push", observation }), "budget");
});

test("retry budgets survive operations, roll over at UTC midnight, and allow explicit attempts", () => {
  let s = initial();
  for (let n = 1; n <= 3; n++) {
    s = step(s, reserve(`op-${n}`));
    s = step(s, { type: "claim", operationId: `op-${n}`, run, provenance, observation });
    s = step(s, { type: "owner-observed", operationId: `op-${n}`, run, status: "completed", conclusion: "failure" });
    s = step(s, { type: "recover-worker", operationId: `op-${n}`, resultAbsent: true });
  }
  fails(() => step(s, reserve("op-4")), "budget");
  assert.equal(operation(step(s, reserve("op-4", { at: "2026-11-13T00:00:00Z" }))).id, "op-4");
  const granted = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, command: { action: "retry", text: "" } }]);
  const commandIds = Object.keys(granted.items["issue:7"].commands);
  assert.equal(operation(step(granted, reserve("op-4", { automatic: false, commandIds }))).id, "op-4");
});

test("aggregate completion needs every required PR and preserves what actually merged", () => {
  let s = step(initial(), { type: "pr-observed", number: 9, state: "merged", mergedSha: C });
  fails(() => step(s, { type: "close-out" }), "incomplete");
  fails(() => step(s, { type: "pr-observed", number: 9, state: "merged", mergedSha: D }), "stale");
  s = step(s, { type: "pr-observed", number: 10, state: "closed" });
  fails(() => step(s, { type: "close-out" }), "incomplete");
  fails(() => step(s, { type: "accept-closure", number: 10, sourceId: "comment:999" }), "invalid");
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 7, command: { action: "answer", text: "accept-closure #10" } }]);
  const commandId = Object.keys(s.items["issue:7"].commands)[0];
  fails(() => step(s, { type: "accept-closure", number: 10, commandId, authorization: { valid: true, revision: "f".repeat(64) } }), "invalid");
  s = step(s, { type: "accept-closure", number: 10, commandId, authorization: observation.authorization });
  assert.equal(step(s, { type: "close-out" }).items["issue:7"].complete, true);
  fails(() => step(s, { type: "accept-closure", number: 10, commandId, authorization: observation.authorization }), "invalid");
  const reopened = step(step(s, { type: "close-out" }), { type: "pr-observed", number: 10, state: "open" });
  assert.equal(reopened.items["issue:7"].complete, false);
  assert.equal(reopened.items["issue:7"].prs[1].acceptedClosure, false);
  assert.equal(reopened.items["issue:7"].prs[1].dispositions[0].sourceId, "issue-comment:999");
  fails(() => step(step(reopened, { type: "pr-observed", number: 10, state: "closed" }), { type: "close-out" }), "incomplete");
});

test("a numbered closure disposition cannot apply to another question, revision or live operation", () => {
  let s = step(initial(), { type: "pr-observed", number: 10, state: "closed" });
  s = ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:999", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, target: 7, command: { action: "answer", text: "1" } }]);
  const event = { type: "accept-closure", number: 10, commandId: Object.keys(s.items["issue:7"].commands)[0], authorization: observation.authorization };
  fails(() => step(s, event), "invalid");
  const asked = step(s, { type: "ask", kind: "pr-closure", number: 10, reason: "Accept #10?" });
  assert.equal(step(asked, event).items["issue:7"].prs[1].acceptedClosure, true);
  fails(() => step(step(asked, { type: "revise", revision: "f".repeat(64) }), { ...event, authorization: { valid: true, revision: "f".repeat(64) } }), "invalid");
  const later = step(s, { type: "ask", kind: "pr-closure", number: 10, reason: "Accept #10?", at: "2026-11-12T12:01:00Z" });
  fails(() => step(later, event), "invalid");
  const live = step(claimed(), { type: "pr-observed", number: 10, state: "closed" });
  fails(() => step(live, event), "busy");
});

test("persisted corruption cannot erase ownership or substitute a different effect", () => {
  const s = pending();
  const cases = [
    (x) => { x.schemaVersion = 999; },
    (x) => { x.items["issue:7"].attempts = []; },
    (x) => { x.items["issue:7"].activeOperation = null; },
    (x) => { x.operations["op-1"].phase = "done"; },
    (x) => { x.operations["op-1"].effects[0].branch = "main"; },
    (x) => { x.operations["op-1"].result.run.attempt = 2; },
    (x) => { x.items["issue:7"].attempts.push(x.items["issue:7"].attempts[0]); },
  ];
  for (const mutate of cases) { const x = structuredClone(s); mutate(x); assert.throws(() => validateLedger(x)); }
});

test("only safe non-protected branch names and real superseding evidence are accepted", () => {
  for (const ref of ["../main", "a//b", "-option", "x.lock", "x/.hidden", "x.", "x/", "x$(foo)"]) assert.equal(validBranch(ref), false, ref);
  for (const branch of ["main", "factory-state"]) fails(() => step(initial(), reserve("op-1", { target: { branch, head: B } })), "corrupt");
  fails(() => step(step(initial(), reserve()), { type: "supersede" }), "invalid");
});
