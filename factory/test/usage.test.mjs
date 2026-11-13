import { test } from "node:test";
import assert from "node:assert/strict";
import { workerMeter, workerUsage, itemUsage, claudeCostScope } from "../lib/usage.mjs";
import { collectUsage } from "../lib/accounting.mjs";
import { ingestCommands, requestRoute, resolveRoute } from "../lib/commands.mjs";
import { validateLedger } from "../lib/protocol.mjs";
import { projectItem } from "../lib/surfaces.mjs";
import { parseConfig } from "../lib/config.mjs";
import { canonical } from "../lib/store.mjs";
import { initial, claimed, step, reserve, operation, run, artifact, proposal, at } from "./fixtures.mjs";

const metrics = { schemaVersion: 1, cost: 0.3, turns: 6, complete: true,
  phases: ["work", "review", "finalize"].map((phase) => ({ phase, cost: 0.1, turns: 2, complete: true })) };
const execution = (op, extra = {}) => ({ source: "actions-job", run: { id: op.owner.id, attempt: op.owner.attempt }, jobId: "321",
  runner: op.worker.runner, ran: true, startedAt: at, completedAt: "2026-11-12T12:02:00Z", durationMs: 120000, ...extra });
function storeFor(initialState) {
  let state = structuredClone(initialState);
  return { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(fn(state)); return { state: structuredClone(state) };
  }, get state() { return state; } };
}
const terminal = () => step(claimed(), { type: "owner-observed", run, status: "completed", conclusion: "failure" });

test("persisted execution and model measurements accept identical recovery without replacing values", () => {
  let state = terminal();
  const events = [{ type: "record-execution", run, usage: execution(operation(state)) }, { type: "record-model-usage", run, artifact, metrics }];
  for (const event of events) {
    state = JSON.parse(canonical(step(state, event)));
    assert.deepEqual(step(state, event), state);
  }
  assert.throws(() => step(state, { ...events[0], usage: { ...events[0].usage, jobId: "322" } }), /replaced/);
  assert.throws(() => step(state, { ...events[1], metrics: { ...metrics, cost: 0.4 } }), /replaced/);
});

test("accounting accepts the configured model and runner length bounds", () => {
  const model = "m".repeat(256), runner = "r".repeat(128);
  const config = parseConfig(`trusted-users: [ntodd]\nrunner: ${runner}\nworker: {model: ${model}}\nrouter: {model: ${model}}`);
  const s = step(initial(), reserve("op-1", { runner: config.runner, model: config.worker.model }));
  assert.equal(operation(s).worker.model, model);
  assert.equal(operation(s).worker.runner, runner);
  assert.equal(workerUsage(metrics, model).reportedUsd, 0.3);
});

test("resumed sessions count only new reported cost, including a missing-outcome follow-up", () => {
  const meter = workerMeter();
  for (const [phase, total] of [["work", 1], ["work", 1.25], ["review", 1.5], ["finalize", 2]]) {
    meter.invocation({ phase, result: { total_cost_usd: total, num_turns: 2 }, completed: true });
  }
  const measured = workerUsage(meter.snapshot(), "opus");
  assert.equal(measured.reportedUsd, 2);
  assert.equal(measured.turns, 8);
  assert.equal(measured.phases[0].reportedUsd, 1.25);
  assert.equal(measured.complete, true);
  assert.equal(claudeCostScope("2.1.276 (Claude Code)"), "invocation");
  assert.equal(claudeCostScope("2.1.277 (Claude Code)"), "cumulative");
  assert.equal(claudeCostScope("unrecognized"), null);
  const old = workerMeter({ scope: "invocation" });
  for (const total of [1, 1.25]) old.invocation({ phase: "work", result: { total_cost_usd: total, num_turns: 2 }, completed: true });
  assert.equal(old.snapshot().cost, 2.25);
});

test("missing, reset, timed-out and malformed reports retain partial cost without declaring completeness", () => {
  for (const next of [{}, { total_cost_usd: 0.1, num_turns: 2 }, { total_cost_usd: 1.5, num_turns: 2 }]) {
    const meter = workerMeter();
    meter.invocation({ phase: "work", result: { total_cost_usd: 1, num_turns: 2 }, completed: true });
    meter.invocation({ phase: "review", result: next, completed: false });
    const value = workerUsage(meter.snapshot(), "opus");
    assert.equal(value.complete, false);
    assert.ok(value.reportedUsd >= 1);
  }
  for (const bad of [undefined, { ...metrics, cost: -1 }, { ...metrics, cost: "0.3" }, { ...metrics, cost: 0 },
    { ...metrics, phases: [...metrics.phases, metrics.phases[0]] }, { ...metrics, turns: 10 }]) {
    assert.equal(workerUsage(bad, "opus").reportedUsd, null);
  }
  const unknownScope = workerMeter({ scope: null });
  unknownScope.invocation({ phase: "work", result: { total_cost_usd: 1, num_turns: 2 }, completed: true });
  assert.equal(unknownScope.snapshot().cost, null);
});

test("artifact acceptance retains metrics without allowing them to authorize publication", () => {
  let s = step(terminal(), { type: "collect-result", artifact, proposal: { ...proposal, metrics } });
  assert.equal(operation(s).usage.model.reportedUsd, 0.3);
  assert.equal(operation(s).usage.model.model, "unknown");
  s = step(s, { type: "record-execution", run, usage: execution(operation(s)) });
  const measured = itemUsage(s, "issue:7");
  assert.equal(measured.crewMinutes, 2);
  assert.equal(measured.workerUnknown, 0);
  assert.deepEqual(step(s, { type: "record-execution", run, usage: execution(operation(s)) }), s);
  assert.throws(() => step(s, { type: "record-execution", run: { ...run, attempt: 2 }, usage: execution(operation(s)) }), /owner/);
  assert.throws(() => step(s, { type: "record-execution", run, usage: execution(operation(s), { durationMs: 0 }) }), /invalid/);
  const stopped = step(s, { type: "stop" });
  assert.equal(itemUsage(stopped, "issue:7").workerReportedUsd, measured.workerReportedUsd);
  assert.equal(operation(step(stopped, { type: "authorize-publish", observation: {} })).phase, "superseded");
  const invalid = step(terminal(), { type: "collect-result", artifact, proposal: { ...proposal, metrics: { cost: 1e99 } } });
  assert.equal(operation(invalid).phase, "result-ready");
  assert.equal(itemUsage(invalid, "issue:7").workerUnknown, 1);
});

test("historical failed attempts remain measurable after replacement, UTC rollover and stop", () => {
  let s = step(terminal(), { type: "recover-worker", resultAbsent: true });
  s = step(s, reserve("op-2", { at: "2026-11-13T00:00:00Z" }));
  s = step(s, { type: "stop" });
  const old = s.operations["op-1"];
  s = step(s, { type: "record-execution", run, usage: execution(old) });
  s = step(s, { type: "record-model-usage", run, artifact, metrics });
  assert.equal(s.items["issue:7"].activeOperation, "op-2");
  assert.equal(itemUsage(s, "issue:7").workerReportedUsd, 0.3);
  assert.equal(itemUsage(s, "issue:7").crewMinutes, 2);
  assert.equal(s.items["issue:7"].attempts.length, 2);
  assert.equal(s.items["issue:7"].paused, true);
  const p = projectItem(s, "issue:7")[0];
  assert.match(p.body, /Claude reports \$0.3000; Crew execution 2.00 min/);
  const hidden = JSON.parse(/<!-- agent-ready:state (.*) -->/.exec(p.body)[1]);
  assert.equal(hidden.usage.workerReportedUsd, 0.3);
});

test("job evidence can prove no execution, while absent data stays unknown", () => {
  const s = terminal();
  assert.equal(itemUsage(s, "issue:7").workerUnknown, 1);
  const zero = step(s, { type: "record-execution", run, usage: execution(operation(s), {
    ran: false, startedAt: null, completedAt: null, durationMs: 0 }) });
  assert.equal(itemUsage(zero, "issue:7").workerUnknown, 0);
  assert.equal(itemUsage(zero, "issue:7").crewMinutes, 0);
});

test("collector recovers failure costs once, disposes artifacts and leaves coding state untouched", async () => {
  const s = step(terminal(), { type: "recover-worker", resultAbsent: true }), store = storeFor(s);
  let jobs = 0, downloads = 0, disposals = 0;
  const actions = { measure: async (op) => { jobs++; return execution(op); }, download: async () => {
    downloads++; return { proposal: { metrics }, artifact, dispose() { disposals++; } };
  } };
  for (let n = 0; n < 3; n++) await collectUsage({ actions, store, context: {}, now: () => at });
  assert.deepEqual([jobs, downloads, disposals], [1, 1, 1]);
  assert.equal(itemUsage(store.state, "issue:7").workerReportedUsd, 0.3);
  assert.equal(operation(store.state).phase, "failed");
  assert.deepEqual(store.state.items["issue:7"].attempts, s.items["issue:7"].attempts);
});

test("collector persists backoff across failures and restarts without calling missing data zero", async () => {
  const store = storeFor(terminal()); let calls = 0;
  const actions = { measure: async () => { calls++; throw new Error("unavailable"); } };
  await collectUsage({ actions, store, context: {}, now: () => at });
  await collectUsage({ actions, store, context: {}, now: () => at });
  assert.equal(calls, 1);
  assert.equal(itemUsage(store.state, "issue:7").executionUnknown, 1);
  await collectUsage({ actions, store, context: {}, now: () => "2026-11-12T12:05:00Z" });
  assert.equal(calls, 2);
  assert.equal(operation(store.state).usage.collection.nextAt, "2026-11-12T12:15:00.000Z");
  assert.equal(operation(store.state).phase, "claimed");
});

test("bounded collection rotates past delayed history and limits artifact transfers", async () => {
  const s = step(terminal(), { type: "recover-worker", resultAbsent: true });
  for (let n = 2; n <= 12; n++) {
    const op = structuredClone(s.operations["op-1"]); op.id = `op-${n}`; op.owner.id = String(100 + n);
    s.operations[op.id] = op;
    s.items["issue:7"].attempts.push({ ...s.items["issue:7"].attempts[0], operation: op.id });
  }
  const store = storeFor(s); let jobs = 0, downloads = 0;
  const actions = { measure: async (op) => { jobs++; return execution(op); }, download: async (op) => {
    downloads++; return { artifact: { ...artifact, run: op.owner }, proposal: { metrics }, dispose() {} };
  } };
  await collectUsage({ actions, store, context: {}, now: () => at });
  assert.deepEqual([jobs, downloads], [8, 2]);
  await collectUsage({ actions, store, context: {}, now: () => at });
  assert.deepEqual([jobs, downloads], [12, 4]);
  assert.equal(itemUsage(store.state, "issue:7").crewMinutes, 24);
  assert.equal(itemUsage(store.state, "issue:7").workerUnknown, 8);
});

test("routing reservations remain counted through refusals, resolved commands and duplicate measurements", () => {
  const fact = { sourceId: "issue-comment:100", revision: "a".repeat(64), authority: "instruction", author: "ntodd",
    createdAt: at, target: 7, command: { action: "route", text: "@ntodd-agent stop" } };
  let s = ingestCommands(initial(), "issue:7", [fact]);
  const commandId = Object.keys(s.items["issue:7"].commands)[0];
  s = requestRoute(s, "issue:7", commandId, at, { model: "router" });
  assert.equal(itemUsage(s, "issue:7").routingUnknown, 1);
  const usage = { source: "responses-api", status: "reported", model: "router", responseId: "resp_123",
    tokens: { input: 20, cachedInput: 10, output: 10, reasoningOutput: 4, total: 30 } };
  s = step(s, { type: "record-routing-usage", commandId, attempt: 1, usage });
  s = resolveRoute(s, "issue:7", commandId, "stop");
  s = JSON.parse(canonical(s));
  assert.deepEqual(step(s, { type: "record-routing-usage", commandId, attempt: 1, usage }), s);
  assert.throws(() => step(s, { type: "record-routing-usage", commandId, attempt: 1, usage: { ...usage, responseId: "resp_other" } }), /replaced/);
  assert.equal(itemUsage(s, "issue:7").routingTokens.total, 30);
  assert.equal(itemUsage(s, "issue:7").routingUnknown, 0);
  assert.equal(itemUsage(s, "issue:7").routingUnpriced, 1);
});
