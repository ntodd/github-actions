import { test } from "node:test";
import assert from "node:assert/strict";
import { runApiEffect, apiEffectId } from "../lib/api-journal.mjs";
import { apiWriter } from "../lib/api-writer.mjs";
import { validateLedger, evolve, admit } from "../lib/protocol.mjs";
import { ingestCommands } from "../lib/commands.mjs";
import { initial, at, run } from "./fixtures.mjs";
function fixture() {
  let state = initial();
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  return { store, get state() { return state; } };
}
const definition = { kind: "comment-create", target: 9, payload: { body: "Queued\n<!-- factory:status=issue:7/9 -->", marker: "<!-- factory:status=issue:7/9 -->" } };

test("a lost comment response is recovered by identity without posting a duplicate", async () => {
  const f = fixture(); let applied = false, sends = 0;
  const writer = { inspect: async () => applied ? { outcome: "applied", receipt: { kind: "comment-create", target: 9, id: 1000 } } : { outcome: "unknown" },
    apply: async () => { sends++; applied = true; throw new Error("response lost"); } };
  const args = { store: f.store, key: "issue:7", slot: "status:9", definition, run, writer, now: () => at };
  assert.equal((await runApiEffect(args)).status, "pending");
  assert.equal((await runApiEffect(args)).status, "applied");
  assert.equal(sends, 1);
  assert.equal(f.state.items["issue:7"].apiEffects[apiEffectId("status:9")].requests[0].receipt.id, 1000);
});

test("absence cannot authorize resubmission of an uncertain notification, even the following day", async () => {
  const f = fixture(); let sends = 0;
  const args = { store: f.store, key: "issue:7", slot: "notice", definition, run,
    writer: { inspect: async () => ({ outcome: "unknown" }), apply: async () => { sends++; throw new Error("network timeout"); } } };
  await runApiEffect({ ...args, now: () => at });
  await runApiEffect({ ...args, now: () => "2026-11-13T12:00:00Z" });
  assert.equal(sends, 1);
});

test("safe projections can repair later drift with a bounded daily request budget", async () => {
  const f = fixture(); let present = false, sends = 0, minute = 0;
  const d = { kind: "label-add", target: 9, payload: { label: "agent-review" } };
  const receipt = { kind: d.kind, target: 9, label: d.payload.label };
  const args = { store: f.store, key: "issue:7", slot: "label", definition: d, run,
    now: () => `2026-11-12T12:${String(minute).padStart(2, "0")}:00Z`,
    writer: { inspect: async () => present ? { outcome: "applied", receipt } : { outcome: "unknown" },
      apply: async () => { sends++; present = true; return { outcome: "applied", receipt }; } } };
  for (minute = 0; minute < 5; minute++) { present = false; await runApiEffect(args); }
  assert.equal(sends, 3);
  await runApiEffect({ ...args, now: () => "2026-11-13T12:00:00Z" });
  assert.equal(sends, 4);
});

test("a stop fences a new metadata request while allowing receipt recovery", async () => {
  const f = fixture();
  const d = { kind: "ready", target: 9, payload: { head: "a".repeat(40), nodeId: "PR_9" },
    guard: { generation: 0, revision: f.state.items["issue:7"].revision } };
  await f.store.transact((s) => { s.items["issue:7"].paused = true; s.items["issue:7"].generation++; return s; });
  let sends = 0;
  const result = await runApiEffect({ store: f.store, key: "issue:7", slot: "ready", definition: d, run, now: () => at,
    writer: { inspect: async () => ({ outcome: "unknown" }), apply: async () => { sends++; } } });
  assert.equal(result.status, "superseded"); assert.equal(sends, 0);
});

test("effect identities cannot be reused and corrupted or out-of-item targets fail validation", async () => {
  const f = fixture(), args = { store: f.store, key: "issue:7", slot: "status", definition, run, now: () => at,
    writer: { inspect: async () => ({ outcome: "unknown" }), apply: async () => ({ outcome: "unknown" }) } };
  await runApiEffect(args);
  await assert.rejects(() => runApiEffect({ ...args, definition: { ...definition, payload: { ...definition.payload, body: `Different\n${definition.payload.marker}` } } }), /identity/);
  await assert.rejects(() => runApiEffect({ ...args, slot: "elsewhere", definition: { ...definition, target: 99 } }), /exceeds/);
  const corrupt = structuredClone(f.state); corrupt.items["issue:7"].apiEffects[apiEffectId("status")].status = "applied";
  assert.throws(() => validateLedger(corrupt), /journal/);
  const prepared = structuredClone(f.state); prepared.items["issue:7"].apiEffects[apiEffectId("status")].status = "prepared";
  assert.throws(() => validateLedger(prepared), /journal/);
});

test("an unknown API outcome gets one nonblocking alert and a known receipt resolves that occurrence", async () => {
  const f = fixture(); let sent = 0, present = false;
  const args = { store: f.store, key: "issue:7", slot: "notice", definition, run, now: () => at,
    writer: { inspect: async () => present ? { outcome: "applied", receipt: { kind: "comment-create", target: 9, id: 1000 } } : { outcome: "unknown" },
      apply: async () => { sent++; throw new Error("Unknown outcome"); } } };
  await runApiEffect(args);
  const sync = (time) => f.store.transact((s) => evolve(s, "issue:7", { type: "sync-api-alerts", at: time, timeoutMinutes: 15 }));
  await sync("2026-11-12T12:16:00Z");
  const alert = Object.values(f.state.items["issue:7"].apiAlerts)[0];
  assert.equal(alert.status, "active"); assert.equal(f.state.items["issue:7"].question, null);
  await sync("2026-11-13T12:16:00Z");
  assert.equal(Object.values(f.state.items["issue:7"].apiAlerts)[0].id, alert.id);
  assert.equal(sent, 1);
  present = true; await runApiEffect({ ...args, recoverOnly: true }); await sync("2026-11-13T12:17:00Z");
  assert.equal(f.state.items["issue:7"].apiAlerts[alert.id].status, "resolved");
  assert.equal(f.state.items["issue:7"].apiAlerts[alert.id].resolution, "applied");
});

test("projection alerts retain separate occurrences and never recurse through their own notifications", async () => {
  const f = fixture(); let present = false;
  const label = { kind: "label-add", target: 9, payload: { label: "agent-review" } };
  const receipt = { kind: "label-add", target: 9, label: "agent-review" };
  const args = { store: f.store, key: "issue:7", slot: "label", definition: label, run,
    writer: { inspect: async () => present ? { outcome: "applied", receipt } : { outcome: "unknown" }, apply: async () => { throw new Error("Unknown label outcome"); } } };
  const sync = (time) => f.store.transact((s) => evolve(s, "issue:7", { type: "sync-api-alerts", at: time, timeoutMinutes: 15 }));
  await runApiEffect({ ...args, now: () => at }); await sync("2026-11-12T12:16:00Z");
  const first = Object.values(f.state.items["issue:7"].apiAlerts)[0];
  const notice = { kind: "comment-create", target: 9, payload: { marker: `<!-- factory:attention=${first.id} -->`, body: `Notice\n<!-- factory:attention=${first.id} -->` } };
  await runApiEffect({ store: f.store, key: "issue:7", slot: `attention:${first.id}`, definition: notice, run, now: () => at,
    writer: { inspect: async () => ({ outcome: "unknown" }), apply: async () => { throw new Error("Notification response unknown"); } } });
  await sync("2026-11-12T13:00:00Z"); assert.equal(Object.keys(f.state.items["issue:7"].apiAlerts).length, 1);
  present = true; await runApiEffect({ ...args, now: () => "2026-11-12T13:01:00Z", recoverOnly: true }); await sync("2026-11-12T13:01:00Z");
  present = false; await runApiEffect({ ...args, now: () => "2026-11-12T13:02:00Z" }); await sync("2026-11-12T13:18:00Z");
  const alerts = Object.values(f.state.items["issue:7"].apiAlerts);
  assert.equal(alerts.length, 2); assert.equal(alerts.filter((a) => a.status === "active").length, 1);
  assert.notEqual(alerts.find((a) => a.status === "active").id, first.id);
});

test("a failed receipt read after a successful write remains uncertain rather than becoming a rejection", async () => {
  const f = fixture(); let reads = 0, sends = 0;
  const writer = apiWriter({ appLogin: "factory[bot]", api: { issue: async () => {
    reads++; if (reads === 2) throw Object.assign(new Error("read failed"), { status: 404 });
    return { labels: reads > 2 ? [{ name: "agent-review" }] : [] };
  } }, write: { addLabels: async () => { sends++; } } });
  const args = { store: f.store, key: "issue:7", slot: "label", definition: { kind: "label-add", target: 9, payload: { label: "agent-review" } }, writer, run, now: () => at };
  assert.equal((await runApiEffect(args)).status, "pending");
  assert.equal((await runApiEffect(args)).status, "applied");
  assert.equal(sends, 1);
});

test("a pending close blocks reopening even if the issue currently looks open", async () => {
  const f = fixture(); let issueState = "open", closes = 0, reopens = 0;
  await f.store.transact((s) => ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:100", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, command: { action: "restart", text: "" } }]));
  const item = f.state.items["issue:7"], commandId = Object.keys(item.commands)[0];
  const guard = { generation: 0, revision: item.revision, commandId }, events = [{ id: 1, event: "labeled", created_at: at }];
  const writer = apiWriter({ appLogin: "factory[bot]", api: { issue: async () => ({ state: issueState }), events: async () => events }, write: {
    closeIssue: async () => { closes++; throw new Error("outcome unknown"); },
    reopenIssue: async () => { reopens++; issueState = "open"; },
  } });
  const args = { store: f.store, key: "issue:7", run, writer, now: () => at };
  const close = { slot: "close", definition: { kind: "issue-close", target: 7, payload: { revision: item.revision }, guard } };
  const reopen = { slot: "reopen", definition: { kind: "issue-reopen", target: 7, payload: {}, guard } };
  assert.equal((await runApiEffect({ ...args, ...close })).status, "pending");
  assert.equal((await runApiEffect({ ...args, ...reopen })).status, "prepared");
  assert.equal(reopens, 0);
  issueState = "closed"; events.push({ id: 2, event: "closed", created_at: at, actor: { login: "factory[bot]" } });
  assert.equal((await runApiEffect({ ...args, ...close, recoverOnly: true })).status, "applied");
  assert.equal((await runApiEffect({ ...args, ...reopen })).status, "applied");
  assert.equal(closes, 1); assert.equal(reopens, 1);
});

test("old App events and human state changes cannot establish a timed-out reopen", async () => {
  const f = fixture(); let issueState = "closed";
  await f.store.transact((s) => ingestCommands(s, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:100", revision: "e".repeat(64),
    author: "ntodd", createdAt: at, command: { action: "restart", text: "" } }]));
  const item = f.state.items["issue:7"], commandId = Object.keys(item.commands)[0];
  const events = [{ id: 50, event: "reopened", created_at: at, actor: { login: "factory[bot]" } }];
  const writer = apiWriter({ appLogin: "factory[bot]", api: { issue: async () => ({ state: issueState }), events: async () => events },
    write: { reopenIssue: async () => { throw new Error("unknown outcome"); } } });
  const args = { store: f.store, key: "issue:7", slot: "reopen", run, writer, now: () => "2026-11-12T12:00:00.900Z",
    definition: { kind: "issue-reopen", target: 7, payload: {}, guard: { generation: 0, revision: item.revision, commandId } } };
  assert.equal((await runApiEffect(args)).requests[0].stateCursor, "50");
  issueState = "open";
  events.push({ id: 51, event: "reopened", created_at: at, actor: { login: "ntodd" } },
    { id: 52, event: "reopened", created_at: "2026-11-12T11:59:59Z", actor: { login: "factory[bot]" } });
  assert.equal((await runApiEffect({ ...args, recoverOnly: true })).status, "pending");
  events.push({ id: 53, event: "reopened", created_at: at, actor: { login: "factory[bot]" } });
  const applied = await runApiEffect({ ...args, recoverOnly: true });
  assert.equal(applied.status, "applied"); assert.equal(applied.receipt.eventId, "53");
  const corrupt = structuredClone(f.state); corrupt.items["issue:7"].apiEffects[apiEffectId("reopen")].receipt.eventId = "50";
  assert.throws(() => validateLedger(corrupt), /journal/);
});

test("a successful close response is a receipt even if subsequent state reads are unavailable", async () => {
  const f = fixture(); let reads = 0, closes = 0;
  const item = f.state.items["issue:7"], writer = apiWriter({ appLogin: "factory[bot]", api: {
    issue: async () => { reads++; if (reads > 1) throw new Error("read unavailable"); return { state: "open" }; },
    events: async () => [],
  }, write: { closeIssue: async () => { closes++; } } });
  const result = await runApiEffect({ store: f.store, key: "issue:7", slot: "close", run, writer, now: () => at,
    definition: { kind: "issue-close", target: 7, payload: { revision: item.revision }, guard: { generation: 0, revision: item.revision } } });
  assert.equal(result.status, "applied"); assert.equal(result.receipt.proof, "response");
  assert.equal(closes, 1); assert.equal(reads, 1);
});

test("state-write exclusion follows the physical PR across item and effect identities", async () => {
  const f = fixture(); let sends = 0;
  // The repository validator now rejects duplicate PR membership. Exercise
  // physical-target exclusion with different endpoint kinds instead.
  await f.store.transact((s) => admit(s, { key: "issue:9", revision: s.items["issue:7"].revision, evidence: { sourceId: "label:124" } }));
  const writer = { inspect: async () => ({ outcome: "unknown", stateCursor: "0" }), apply: async () => { sends++; return { outcome: "unknown" }; } };
  for (const key of ["issue:7", "issue:9"]) {
    await f.store.transact((s) => ingestCommands(s, key, [{ authority: "instruction", sourceId: "issue-comment:100", revision: "e".repeat(64),
      author: "ntodd", createdAt: at, command: { action: "restart", text: "" } }]));
    const item = f.state.items[key], commandId = Object.keys(item.commands)[0];
    const result = await runApiEffect({ store: f.store, key, slot: "same-slot", run, writer, now: () => at,
      definition: { kind: key === "issue:7" ? "pr-close" : "issue-close", target: 9,
        payload: key === "issue:7" ? { head: "a".repeat(40) } : { revision: item.revision }, guard: { generation: 0, revision: item.revision, commandId } } });
    assert.equal(result.status, key === "issue:7" ? "pending" : "prepared");
  }
  assert.equal(sends, 1);
});
