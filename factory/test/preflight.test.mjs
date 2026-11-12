import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightRead, preflightId } from "../lib/recovery.mjs";
import { validateLedger, evolve } from "../lib/protocol.mjs";
import { initial, claimed, at } from "./fixtures.mjs";

function fixture(state = initial()) {
  let clock = at, writes = 0;
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); writes++; return { state: structuredClone(state) };
  } };
  return { store, get state() { return state; }, get writes() { return writes; }, tick(time) { clock = time; },
    observe: (read, extra = {}) => preflightRead({ store, key: "issue:7", item: structuredClone(state.items["issue:7"]), kind: "labels", target: 9,
      stage: "plan", now: () => clock, read, ...extra }),
    sync: () => store.transact((s) => evolve(s, "issue:7", { type: "sync-api-alerts", at: clock, timeoutMinutes: 15 })) };
}

test("healthy preflight reads add no ledger writes or recovery records", async () => {
  const f = fixture(); let reads = 0;
  assert.deepEqual(await f.observe(async () => { reads++; return ["bug"]; }), ["bug"]);
  assert.equal(reads, 1); assert.equal(f.writes, 0); assert.equal(f.state.items["issue:7"].preflights, undefined);
});

test("failed observations back off, escalate once and retain only public error classifications", async () => {
  const f = fixture(claimed()), owner = structuredClone(f.state.operations["op-1"]); let reads = 0;
  const unavailable = async () => { reads++; throw Object.assign(new Error("token=private-provider-detail"), { status: 503 }); };
  await assert.rejects(f.observe(unavailable), /private-provider-detail/);
  await assert.rejects(f.observe(unavailable), (e) => e.code === "preflight-wait"); assert.equal(reads, 1);
  for (const time of ["2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z"]) { f.tick(time); await assert.rejects(f.observe(unavailable)); }
  await f.sync();
  const item = f.state.items["issue:7"], read = Object.values(item.preflights)[0], alert = Object.values(item.apiAlerts)[0];
  assert.equal(read.failures, 3); assert.equal(read.nextAt, "2026-11-12T12:07:00.000Z");
  assert.equal(alert.source, "preflight"); assert.equal(alert.request, undefined); assert.equal(alert.status, "active");
  assert.equal(item.apiEffects, undefined); assert.equal(item.question, null);
  assert.equal(JSON.stringify(f.state).includes("private-provider-detail"), false);
  assert.deepEqual(f.state.operations["op-1"], owner);
  await f.sync(); assert.equal(Object.keys(f.state.items["issue:7"].apiAlerts).length, 1);
});

test("preflight recovery settles an incident and a later outage starts a separate occurrence", async () => {
  const f = fixture(), fail = async () => { throw new Error("unavailable"); };
  await assert.rejects(f.observe(fail)); f.tick("2026-11-12T12:16:00Z"); await f.sync();
  const first = Object.values(f.state.items["issue:7"].apiAlerts)[0];
  await f.observe(async () => false); await f.sync();
  assert.equal(f.state.items["issue:7"].apiAlerts[first.id].resolution, "observed");
  assert.equal(Object.values(f.state.items["issue:7"].preflights)[0].status, "observed");
  f.tick("2026-11-12T12:17:00Z"); await assert.rejects(f.observe(fail));
  f.tick("2026-11-12T12:33:00Z"); await f.sync();
  const alerts = Object.values(f.state.items["issue:7"].apiAlerts);
  assert.equal(alerts.length, 2); assert.equal(alerts.filter((a) => a.status === "active").length, 1);
  assert.notEqual(alerts.find((a) => a.status === "active").id, first.id);
  assert.equal(Object.keys(f.state.items["issue:7"].preflights).length, 1);
});

test("known stop or terminal PR observations settle preflights without pretending a read succeeded", async () => {
  for (const stop of [true, false]) {
    const f = fixture(), item = f.state.items["issue:7"];
    await assert.rejects(f.observe(async () => { throw new Error("unavailable"); }, { kind: "ready", stage: "guard",
      guard: { generation: item.generation, revision: item.revision } }));
    f.tick("2026-11-12T12:16:00Z"); await f.sync();
    const id = Object.values(f.state.items["issue:7"].apiAlerts)[0].id;
    await f.store.transact((s) => evolve(s, "issue:7", stop ? { type: "stop" } : { type: "pr-observed", number: 9, state: "closed" }));
    await f.sync();
    assert.equal(f.state.items["issue:7"].apiAlerts[id].resolution, "superseded");
    assert.equal(Object.values(f.state.items["issue:7"].preflights)[0].status, "superseded");
  }
});

test("failed notification reads have backoff and cannot generate attention notices about themselves", async () => {
  const f = fixture(); let reads = 0;
  const fail = async () => { reads++; throw new Error("unavailable"); };
  await assert.rejects(f.observe(fail, { kind: "notification", stage: "inspect" }));
  await assert.rejects(f.observe(fail, { kind: "notification", stage: "inspect" }), (e) => e.code === "preflight-wait");
  f.tick("2026-11-12T13:00:00Z"); await f.sync();
  assert.equal(reads, 1); assert.equal(f.state.items["issue:7"].apiAlerts, undefined);
});

test("preflight identities, guards and historical alert references are validated", async () => {
  const f = fixture(); let reads = 0;
  for (const extra of [{ target: 99 }, { kind: "arbitrary" }, { stage: "write" }, { runId: "123" }, { guard: { generation: -1 } }]) {
    await assert.rejects(f.observe(async () => { reads++; }, extra));
  }
  assert.equal(reads, 0); assert.equal(f.writes, 0);
  await assert.rejects(f.observe(async () => { throw new Error("unavailable"); }));
  f.tick("2026-11-12T12:16:00Z"); await f.sync();
  for (const change of [
    (s) => { s.items["issue:7"].preflights[preflightId("labels", 9, "plan")].target = 99; },
    (s) => { Object.values(s.items["issue:7"].preflights)[0].failures = -1; },
    (s) => { Object.values(s.items["issue:7"].apiAlerts)[0].read = "invented-request"; },
  ]) { const state = structuredClone(f.state); change(state); assert.throws(() => validateLedger(state), (e) => e.code === "corrupt"); }
});
