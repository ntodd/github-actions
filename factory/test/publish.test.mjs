import { test } from "node:test";
import assert from "node:assert/strict";
import { publishOperation } from "../lib/publish.mjs";
import { validateLedger } from "../lib/protocol.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { parseConfig } from "../lib/config.mjs";
import { C, D, at, observation, operation, ready, pending, step } from "./fixtures.mjs";
function memoryStore(initial) {
  let state = initial, version = 0;
  return { async load() { return { state: structuredClone(state), tip: String(version) }; },
    async transact(fn) { state = validateLedger(await fn(structuredClone(state))); version++; return this.load(); } };
}
function context(initial = ready()) {
  const store = memoryStore(initial), calls = [];
  const writer = {
    async validate(effect) { calls.push(["validate", effect.id]); },
    async inspect(effect) { calls.push(["inspect", effect.id]); return { outcome: "unknown" }; },
    async apply(effect) {
      assert.equal(operation((await store.load()).state).effects[0].status, "pending", "intent is committed before the remote write");
      calls.push(["apply", effect.id]);
      return { outcome: "applied", evidence: { kind: "branch-head", commit: C } };
    },
  };
  return { store, calls, writer, itemKey: "issue:7", operationId: "op-1", publisherRun: { id: "900", attempt: 1 },
    observe: async () => observation, now: () => at };
}

test("publisher commits intent before code and completion after its receipt", async () => {
  const c = context();
  assert.equal((await publishOperation(c)).status, "done");
  assert.equal(operation((await c.store.load()).state).effects[0].receipt.commit, C);
  assert.equal((await publishOperation(c)).status, "done");
  assert.deepEqual(c.calls, [["validate", "push"], ["apply", "push"]]);
});

test("an applied write with a lost response is inspected and never submitted again", async () => {
  const c = context();
  c.writer.apply = async () => { c.calls.push(["apply", "push"]); throw new Error("lost response after commit"); };
  assert.equal((await publishOperation(c)).status, "waiting");
  assert.equal(operation((await c.store.load()).state).effects[0].status, "pending");
  c.writer.inspect = async () => ({ outcome: "applied", evidence: { kind: "commit-ancestor", commit: C } });
  assert.equal((await publishOperation(c)).status, "done");
  assert.equal(c.calls.filter(([kind]) => kind === "apply").length, 1);
});

test("unknown effects remain pending across passes and an intervening stop", async () => {
  const c = context(pending());
  for (let i = 0; i < 3; i++) assert.equal((await publishOperation(c)).status, "waiting");
  await c.store.transact((s) => step(s, { type: "stop" }));
  assert.equal((await publishOperation(c)).status, "waiting");
  assert.equal(c.calls.filter(([kind]) => kind === "apply").length, 0);
  c.writer.inspect = async () => ({ outcome: "applied", evidence: { kind: "commit-ancestor", commit: C } });
  assert.equal((await publishOperation(c)).status, "done");
  assert.equal((await c.store.load()).state.items["issue:7"].paused, true);
});

test("validation and fresh authorization precede any request", async () => {
  const c = context();
  c.writer.validate = async () => { throw new Error("commit changed workflows"); };
  await assert.rejects(publishOperation(c), /changed workflows/);
  assert.equal(operation((await c.store.load()).state).effects[0].requests.length, 0);
  c.writer.validate = async () => {};
  c.observe = async () => ({ ...observation, head: D });
  // Already authorized by the previous pass; retire the now-stale proposal
  // without leaving a permanently unfinished publication or sending a write.
  assert.equal((await publishOperation(c)).status, "superseded");
  assert.equal(operation((await c.store.load()).state).effects[0].requests.length, 0);
});

test("recovery clears only its own exact-outcome question, preserving stop and avoiding another push", async () => {
  const c = context(pending());
  await c.store.transact((s) => step(s, { type: "ask", kind: "publish-outcome", reason: "Investigate the request", at,
    recovery: { operation: "op-1", effect: "push", request: "op-1/push/1" } }));
  await c.store.transact((s) => step(s, { type: "stop" }));
  c.writer.inspect = async () => ({ outcome: "applied", evidence: { kind: "commit-ancestor", commit: C } });
  assert.equal((await publishOperation(c)).status, "done");
  const state = (await c.store.load()).state;
  assert.equal(state.items["issue:7"].question, null); assert.equal(state.items["issue:7"].paused, true);
  assert.equal(c.calls.some(([kind]) => kind === "apply"), false);
});

test("a remote receipt cannot clear an unrelated human decision", async () => {
  const c = context(pending());
  await c.store.transact((s) => step(s, { type: "ask", reason: "Choose whether the API should change" }));
  c.writer.inspect = async () => ({ outcome: "applied", evidence: { kind: "branch-head", commit: C } });
  await publishOperation(c);
  assert.equal((await c.store.load()).state.items["issue:7"].question.reason, "Choose whether the API should change");
});

test("definitively rejected publication backs off and exhausts its budget into a visible question", async () => {
  const c = context(); let time = at, calls = 0;
  c.now = () => time;
  c.writer.apply = async () => { calls++; return { outcome: "rejected", evidence: { kind: "http-rejection", status: 403 } }; };
  await publishOperation(c); await publishOperation(c);
  assert.equal(calls, 1);
  time = "2026-11-12T12:01:00Z"; await publishOperation(c);
  time = "2026-11-12T12:03:00Z"; await publishOperation(c);
  assert.equal(calls, 3);
  await c.store.transact((state) => {
    const plan = decideItem(state, "issue:7", { authorization: observation.authorization, prs: [], feedback: [] },
      parseConfig("trusted-users: [ntodd]"), { now: time });
    return plan.events.reduce((s, event) => step(s, event), state);
  });
  assert.match((await c.store.load()).state.items["issue:7"].question.reason, /request budget.*403/);
  assert.equal((await publishOperation(c)).status, "superseded");
  assert.equal(calls, 3);
});
