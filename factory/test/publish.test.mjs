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

test("publication observation failures back off and recover the accepted result without a replacement worker", async () => {
  const c = context(), original = operation((await c.store.load()).state); let time = at, reads = 0;
  c.now = () => time;
  c.observe = async () => { reads++; throw Object.assign(new Error("private upstream detail"), { status: 503 }); };
  await assert.rejects(publishOperation(c), /private upstream detail/);
  assert.equal((await publishOperation(c)).status, "waiting"); assert.equal(reads, 1);
  time = "2026-11-12T12:16:00Z";
  await c.store.transact((s) => step(s, { type: "sync-api-alerts", timeoutMinutes: 15, at: time }));
  let state = (await c.store.load()).state;
  const alert = Object.values(state.items["issue:7"].apiAlerts)[0];
  assert.equal(alert.source, "preflight"); assert.equal(alert.kind, "publish"); assert.equal(alert.request, undefined);
  assert.match(alert.reason, /op-1/); assert.equal(JSON.stringify(state).includes("private upstream detail"), false);
  assert.deepEqual(operation(state), original); assert.equal(state.items["issue:7"].question, null);
  c.observe = async () => observation;
  assert.equal((await publishOperation(c)).status, "done");
  await c.store.transact((s) => step(s, { type: "sync-api-alerts", timeoutMinutes: 15, at: time }));
  state = (await c.store.load()).state;
  assert.equal(state.items["issue:7"].apiAlerts[alert.id].resolution, "observed");
  assert.equal(state.items["issue:7"].attempts.length, 1);
  assert.equal(c.calls.filter(([kind]) => kind === "apply").length, 1);
});

test("incomplete publication observations are recoverable reads rather than evidence that accepted work is stale", async () => {
  for (const patch of [{ head: undefined }, { baseSha: undefined }, { authorization: { valid: true } }]) {
    const c = context(); c.observe = async () => ({ ...observation, ...patch });
    await assert.rejects(publishOperation(c), /could not be observed completely/);
    const state = (await c.store.load()).state;
    assert.equal(operation(state).phase, "result-ready");
    assert.equal(operation(state).effects[0].requests.length, 0);
    assert.equal(Object.values(state.items["issue:7"].preflights)[0].code, "unavailable");
    assert.deepEqual(c.calls, []);
  }
});

test("publication validation read outages retain the proposal, back off, and recover without another worker", async () => {
  const c = context(); let time = at, reads = 0;
  c.now = () => time;
  c.writer.validate = async () => { reads++; throw Object.assign(new Error("private transport detail"), { code: "read-unavailable", status: 503 }); };
  await assert.rejects(publishOperation(c), /private transport detail/);
  let state = (await c.store.load()).state;
  assert.equal(operation(state).publishError, undefined);
  assert.equal(operation(state).phase, "publishing");
  assert.equal(Object.values(state.items["issue:7"].preflights)[0].stage, "inspect");
  assert.equal((await publishOperation(c)).status, "waiting"); assert.equal(reads, 1);
  time = "2026-11-12T12:16:00Z";
  await c.store.transact((state) => {
    const plan = decideItem(state, "issue:7", { authorization: observation.authorization, prs: [], feedback: [] },
      parseConfig("trusted-users: [ntodd]"), { now: time });
    return plan.events.reduce((s, event) => step(s, event), state);
  });
  state = (await c.store.load()).state;
  assert.equal(state.items["issue:7"].question, null);
  const alert = Object.values(state.items["issue:7"].apiAlerts)[0];
  assert.equal(alert.source, "preflight"); assert.equal(JSON.stringify(state).includes("private transport detail"), false);
  c.writer.validate = async () => { reads++; };
  assert.equal((await publishOperation(c)).status, "done");
  await c.store.transact((s) => step(s, { type: "sync-api-alerts", timeoutMinutes: 15, at: time }));
  state = (await c.store.load()).state;
  assert.equal(state.items["issue:7"].apiAlerts[alert.id].resolution, "observed");
  assert.equal(state.items["issue:7"].attempts.length, 1);
  assert.equal(c.calls.filter(([kind]) => kind === "apply").length, 1);
});

test("a failing last observation has its own backoff and cannot turn a read deadline into discarded code", async () => {
  const c = context(); let time = at, afterValidation = false, failures = 0;
  c.now = () => time;
  c.writer.validate = async () => { afterValidation = true; };
  c.observe = async () => {
    if (afterValidation) { failures++; throw Object.assign(new Error("read unavailable"), { status: 503 }); }
    return observation;
  };
  for (const stamp of [at, "2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z"]) {
    time = stamp; afterValidation = false; await assert.rejects(publishOperation(c), /read unavailable/);
  }
  afterValidation = false;
  assert.equal((await publishOperation(c)).status, "waiting"); assert.equal(failures, 3);
  time = "2026-11-12T12:16:00Z";
  await c.store.transact((state) => {
    const plan = decideItem(state, "issue:7", { authorization: observation.authorization, prs: [], feedback: [] },
      parseConfig("trusted-users: [ntodd]"), { now: time });
    return plan.events.reduce((s, event) => step(s, event), state);
  });
  let state = (await c.store.load()).state;
  assert.equal(state.items["issue:7"].question, null);
  assert.equal(Object.values(state.items["issue:7"].apiAlerts).filter((a) => a.status === "active").length, 1);
  assert.equal(operation(state).effects[0].requests.length, 0);
  c.observe = async () => observation;
  assert.equal((await publishOperation(c)).status, "done");
  state = (await c.store.load()).state;
  assert.equal(operation(state).effects[0].requests.length, 1);
  assert.equal(state.items["issue:7"].attempts.length, 1);
});

test("a recorded stop retires unsent publication despite read backoff and an unavailable API", async () => {
  for (const publishing of [false, true]) {
    const c = context(); let reads = 0, time = at;
    c.now = () => time;
    c.observe = async () => { if (++reads >= (publishing ? 2 : 1)) throw new Error("unavailable"); return observation; };
    await assert.rejects(publishOperation(c)); time = "2026-11-12T12:16:00Z";
    await c.store.transact((s) => step(s, { type: "sync-api-alerts", timeoutMinutes: 15, at: time }));
    const alert = Object.values((await c.store.load()).state.items["issue:7"].apiAlerts)[0];
    await c.store.transact((s) => step(s, { type: "stop", at: time }));
    assert.equal((await publishOperation(c)).status, "superseded");
    assert.equal(reads, publishing ? 2 : 1); assert.deepEqual(c.calls, []);
    await c.store.transact((s) => step(s, { type: "sync-api-alerts", timeoutMinutes: 15, at: time }));
    const state = (await c.store.load()).state;
    assert.equal(state.items["issue:7"].paused, true);
    assert.equal(state.items["issue:7"].apiAlerts[alert.id].resolution, "superseded");
  }
});

test("a failed preflight record cannot delay receipt recovery for an actually sent request", async () => {
  const c = context(); let reads = 0;
  c.observe = async () => { if (++reads > 1) throw new Error("unavailable"); return observation; };
  await assert.rejects(publishOperation(c));
  await c.store.transact((s) => step(s, { type: "request-effect", effectId: "push", observation }));
  let inspected = 0;
  c.writer.inspect = async () => { inspected++; return { outcome: "applied", evidence: { kind: "branch-head", commit: C } }; };
  assert.equal((await publishOperation(c)).status, "done");
  assert.equal(inspected, 1); assert.equal(reads, 2); assert.deepEqual(c.calls, []);
  await c.store.transact((s) => step(s, { type: "sync-api-alerts", timeoutMinutes: 15 }));
  const state = (await c.store.load()).state;
  assert.equal(operation(state).effects[0].requests.length, 1);
  assert.equal(Object.values(state.items["issue:7"].preflights)[0].status, "superseded");
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
