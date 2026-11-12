import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestCommands, revalidateCommands, applyControls, queuedCommands, resumeForCommand, resolveRoute, requestRoute, routeNextAt, pendingControls } from "../lib/commands.mjs";
import { classifyText, classifyLabel } from "../lib/admission.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, reserve, step, at, observation, run, provenance, artifact, proposal, operation } from "./fixtures.mjs";
const config = parseConfig("trusted-users: [ntodd]");
const fact = (id, body, minute = 0) => classifyText({ id, body, author: "ntodd", lastEditedAt: null,
  createdAt: `2026-11-12T12:${String(minute).padStart(2, "0")}:00Z` }, "issue-comment", config, { target: 7 });

test("repeated delivery is deduplicated by source/revision, including late-visible older comments", () => {
  const first = fact(2, "/agent respond", 2), late = fact(1, "/agent update", 1);
  const one = ingestCommands(initial(), "issue:7", [first]);
  const two = ingestCommands(one, "issue:7", [first, late]);
  assert.equal(Object.keys(two.items["issue:7"].commands).length, 2);
  assert.deepEqual(queuedCommands(two.items["issue:7"]).map((c) => c.sourceId), ["issue-comment:1", "issue-comment:2"]);
});

test("stop supersedes older queued work; status and effort do not resume it", () => {
  const s = applyControls(ingestCommands(initial(), "issue:7", [fact(1, "/agent respond"), fact(2, "/agent stop", 1), fact(3, "/agent status", 2), fact(4, "/effort high", 3)]), "issue:7");
  const item = s.items["issue:7"];
  assert.equal(item.paused, true);
  assert.equal(item.generation, 1);
  assert.equal(item.effort, "high");
  assert.equal(Object.values(item.commands).find((c) => c.action === "respond").status, "superseded");
  assert.deepEqual(applyControls(s, "issue:7"), s);
});

test("an explicit work request resumes and is incorporated only on accepted outcome", () => {
  let s = step(initial(), { type: "stop" });
  s = ingestCommands(s, "issue:7", [fact(1, "/agent respond")]);
  const commandId = Object.keys(s.items["issue:7"].commands)[0];
  s = resumeForCommand(s, "issue:7", commandId);
  s = step(s, reserve("op-1", { commandIds: [commandId], automatic: false }));
  assert.equal(s.items["issue:7"].commands[commandId].status, "reserved");
  s = step(s, { type: "claim", run, provenance, observation });
  s = step(s, { type: "owner-observed", run, status: "completed", conclusion: "success" });
  s = step(s, { type: "collect-result", proposal, artifact });
  assert.equal(s.items["issue:7"].commands[commandId].status, "reserved");
  s = step(s, { type: "authorize-publish", observation });
  s = step(s, { type: "request-effect", effectId: "push", observation });
  s = step(s, { type: "effect-observed", effectId: "push", requestId: "op-1/push/1", outcome: "applied", evidence: { kind: "branch-head", commit: proposal.effects[0].commit } });
  s = step(s, { type: "finish-publish" });
  assert.equal(s.items["issue:7"].commands[commandId].status, "incorporated");
  assert.equal(queuedCommands(s.items["issue:7"]).length, 0);
});

test("routing preserves the human source and cannot select an unrecognized action", () => {
  const s = ingestCommands(initial(), "issue:7", [fact(1, "@ntodd-agent bring this up to date")]);
  const id = Object.keys(s.items["issue:7"].commands)[0];
  assert.throws(() => resolveRoute(s, "issue:7", id, "merge"));
  const next = resolveRoute(s, "issue:7", id, "update");
  assert.equal(next.items["issue:7"].commands[id].action, "update");
  assert.equal(next.items["issue:7"].commands[id].sourceId, "issue-comment:1");
  assert.equal(next.items["issue:7"].commands[id].text, "@ntodd-agent bring this up to date");
});

test("a caller cannot change committed protocol snapshots by mutating an event object", () => {
  const event = reserve();
  const s = step(initial(), event);
  event.target.branch = "main";
  assert.equal(operation(s).target.branch, "factory/issue-7");
});

test("a complete conversation reread removes queued commands whose source changed", () => {
  const original = fact(99, "/agent respond fix it");
  const s = ingestCommands(initial(), "issue:7", [original]);
  const next = revalidateCommands(s, "issue:7", []);
  assert.equal(Object.values(next.items["issue:7"].commands)[0].status, "superseded");
  assert.equal(s.items["issue:7"].generation, next.items["issue:7"].generation);
});

test("removing a command that authorized an active result fences publication exactly once", () => {
  const original = fact(99, "/agent respond fix it");
  let s = ingestCommands(initial(), "issue:7", [original]);
  const id = Object.keys(s.items["issue:7"].commands)[0];
  s = step(s, reserve("op-1", { automatic: false, commandIds: [id] }));
  s = step(s, { type: "claim", run, provenance, observation });
  s = step(s, { type: "owner-observed", run, status: "completed", conclusion: "success" });
  s = step(s, { type: "collect-result", artifact, proposal });
  const next = revalidateCommands(s, "issue:7", []);
  assert.equal(next.items["issue:7"].generation, 1);
  assert.match(next.items["issue:7"].question.reason, /changed or disappeared/);
  assert.equal(revalidateCommands(next, "issue:7", []).items["issue:7"].generation, 1);
  assert.equal(step(next, { type: "authorize-publish", observation }).operations["op-1"].phase, "superseded");
});

test("same-second command IDs sort numerically so a stop at 100 supersedes work at 99", () => {
  const state = applyControls(ingestCommands(initial(), "issue:7", [fact(99, "/agent respond"), fact(100, "/agent stop")]), "issue:7");
  assert.equal(state.items["issue:7"].paused, true);
  assert.equal(Object.values(state.items["issue:7"].commands).find((c) => c.action === "respond").status, "superseded");
});

test("a same-second work request with a newer ID remains an explicit way to resume", () => {
  const state = applyControls(ingestCommands(initial(), "issue:7", [fact(99, "/agent stop"), fact(100, "/agent respond")]), "issue:7");
  assert.equal(queuedCommands(state.items["issue:7"])[0].action, "respond");
});

test("a later stop supersedes an older unread mention instead of letting it resume work", () => {
  const state = applyControls(ingestCommands(initial(), "issue:7", [fact(99, "@ntodd-agent fix it"), fact(100, "/agent stop")]), "issue:7");
  assert.equal(state.items["issue:7"].paused, true);
  assert.equal(queuedCommands(state.items["issue:7"]).length, 0);
});

test("routing requests spend durable bounded attempts even when the model response is lost", () => {
  let state = ingestCommands(initial(), "issue:7", [fact(99, "@ntodd-agent fix it")]);
  const id = queuedCommands(state.items["issue:7"])[0].id;
  state = requestRoute(state, "issue:7", id, at);
  assert.throws(() => requestRoute(state, "issue:7", id, at));
  for (let n = 0; n < 2; n++) state = requestRoute(state, "issue:7", id, routeNextAt(state.items["issue:7"].commands[id]));
  assert.throws(() => requestRoute(state, "issue:7", id, "2026-11-12T13:00:00Z"));
  assert.equal(state.items["issue:7"].commands[id].routingAttempts.length, 3);
});

test("admission and older labels never replay builds, while a trusted new relabel answers a question", () => {
  const label = (id, name = "agent-ready") => classifyLabel({ id, event: "labeled", label: { name },
    actor: { login: "ntodd" }, created_at: at }, config, 7);
  let state = step(initial(), { type: "ask", reason: "Choose the implementation" });
  state = ingestCommands(state, "issue:7", [label(122), label(123), label(124), label(125, "effort:high")]);
  const commands = Object.values(state.items["issue:7"].commands);
  assert.equal(commands.length, 2);
  assert.equal(commands.find((c) => c.sourceId === "label:124").action, "answer");
  assert.equal(applyControls(state, "issue:7").items["issue:7"].effort, "high");
  assert.deepEqual(ingestCommands(state, "issue:7", [label(124), label(125, "effort:max")]), state);
});

test("a late-visible older work request cannot undo an already applied stop", () => {
  let state = applyControls(ingestCommands(initial(), "issue:7", [fact(100, "/agent stop", 2)]), "issue:7");
  state = applyControls(ingestCommands(state, "issue:7", [fact(99, "/agent respond", 1)]), "issue:7");
  assert.equal(state.items["issue:7"].paused, true);
  assert.equal(queuedCommands(state.items["issue:7"]).length, 0);
  assert.equal(state.items["issue:7"].generation, 1);
});

test("an older stop/restart revealed after newer work was reserved cannot revoke that newer intent", () => {
  for (const action of ["stop", "restart"]) {
    let state = ingestCommands(initial(), "issue:7", [fact(100, "/agent respond", 2)]);
    const id = queuedCommands(state.items["issue:7"])[0].id;
    state = step(state, reserve("op-1", { commandIds: [id], automatic: false }));
    assert.deepEqual(pendingControls(state.items["issue:7"], [fact(99, `/agent ${action}`, 1)]), []);
    state = applyControls(ingestCommands(state, "issue:7", [fact(99, `/agent ${action}`, 1)]), "issue:7");
    assert.equal(state.items["issue:7"].paused, false);
    assert.equal(state.items["issue:7"].generation, 0);
    assert.equal(state.operations["op-1"].phase, "prepared");
    assert.equal(state.items["issue:7"].restart, undefined);
    assert.equal(Object.values(state.items["issue:7"].commands).find((c) => c.sourceId === "issue-comment:99").status, "superseded");
  }
});

test("an unread issue stop answer fences publication, and accepted continue decisions order late-visible controls", () => {
  let state = step(initial(), { type: "ask", kind: "issue-closure", reason: "Stop or continue?" });
  assert.equal(pendingControls(state.items["issue:7"], [fact(99, "/agent answer 2", 1)]).length, 1);
  state = ingestCommands(state, "issue:7", [fact(100, "/agent answer continue", 2)]);
  const commandId = Object.keys(state.items["issue:7"].commands)[0];
  state = step(state, { type: "answer-issue-closure", decision: "continue", commandId, authorization: observation.authorization, at: "2026-11-12T12:02:00Z" });
  assert.equal(pendingControls(state.items["issue:7"], [fact(101, "/agent answer stop", 3)]).length, 1);
  for (const action of ["stop", "restart"]) {
    assert.equal(pendingControls(state.items["issue:7"], [fact(99, `/agent ${action}`, 1)]).length, 0);
    const late = applyControls(ingestCommands(state, "issue:7", [fact(99, `/agent ${action}`, 1)]), "issue:7");
    assert.equal(late.items["issue:7"].generation, 0); assert.equal(late.items["issue:7"].paused, false);
  }
});

test("a routed numbered stop answer fences writes before its control transition is applied", () => {
  let state = step(initial(), { type: "ask", kind: "issue-closure", reason: "Stop or continue?" });
  const mention = fact(100, "@ntodd-agent go with option 2", 1);
  state = ingestCommands(state, "issue:7", [mention]);
  const commandId = Object.keys(state.items["issue:7"].commands)[0];
  state = resolveRoute(state, "issue:7", commandId, "answer", null, { handle: "ntodd-agent" });
  assert.equal(state.items["issue:7"].generation, 0);
  assert.equal(pendingControls(state.items["issue:7"], [mention]).length, 1);
});
