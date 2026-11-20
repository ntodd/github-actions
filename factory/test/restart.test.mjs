import { test } from "node:test";
import assert from "node:assert/strict";
import { restartService } from "../lib/restart.mjs";
import { surfaceService } from "../lib/surfaces.mjs";
import { ingestCommands, applyControls } from "../lib/commands.mjs";
import { classifyText } from "../lib/admission.mjs";
import { parseConfig } from "../lib/config.mjs";
import { evolve, validateLedger } from "../lib/protocol.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { initial, claimed, A, B, C, at, reserve, step } from "./fixtures.mjs";

function fixture({ live = false, closedIssue = false } = {}) {
  let state = live ? claimed() : initial(), issueState = closedIssue ? "closed" : "open", id = 1000;
  const config = parseConfig("trusted-users: [ntodd]"), prs = new Map([9, 10].map((number) => [number, {
    number, state: "open", head: { sha: B, ref: `factory/pr-${number}`, repo: { full_name: "ntodd/project" } },
    base: { ref: "main", sha: A }, user: { login: "ntodd-agent[bot]" },
  }]));
  const comments = [], writes = [], stateEvents = new Map([[7, []], [9, []], [10, []]]);
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const api = { repository: async () => ({ id: 42, default_branch: "main" }), branchSha: async () => A,
    fileAt: async () => ({ content: "trusted-users: [ntodd]" }),
    issue: async () => ({ number: 7, state: issueState, title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }),
    pull: async (n) => prs.get(n), editors: async () => [], comments: async (n) => n === 7 ? comments : [], reviews: async () => [], threads: async () => [],
    events: async (n) => [{ id: 123, event: "labeled", created_at: "2026-11-12T00:00:00Z", label: { name: "agent-ready" }, actor: { login: "ntodd" } }, ...stateEvents.get(n)],
  };
  const write = {
    closePull: async (n) => { writes.push(["close", n]); prs.get(n).state = "closed";
      stateEvents.get(n).push({ id: id++, event: "closed", created_at: at, actor: { login: "ntodd-agent[bot]" } }); },
    reopenIssue: async () => { writes.push(["reopen"]); issueState = "open";
      stateEvents.get(7).push({ id: id++, event: "reopened", created_at: at, actor: { login: "ntodd-agent[bot]" } }); },
  };
  const effects = surfaceService({ api, write, store, repo: "ntodd/project", appLogin: "ntodd-agent[bot]", run: { id: "900", attempt: 1 }, now: () => at });
  const restart = restartService({ api, store, effects, appLogin: "ntodd-agent[bot]", now: () => at });
  async function command(body) {
    const row = { id: id++, body, user: { login: "ntodd" }, created_at: at, updated_at: at }; comments.push(row);
    await store.transact((s) => applyControls(ingestCommands(s, "issue:7", [classifyText(row, "issue-comment", config, { target: 7 })]), "issue:7", { now: at }));
    return Object.values(state.items["issue:7"].commands).at(-1);
  }
  return { store, api, write, writes, prs, config, restart, command, get state() { return state; } };
}

test("restart closes all recorded PRs and reserves one replacement build on the same issue", async () => {
  const f = fixture(), request = await f.command("/agent restart");
  assert.equal((await f.restart({ key: "issue:7" })).status, "ready");
  assert.deepEqual(f.writes, [["close", 9], ["close", 10]]);
  const item = f.state.items["issue:7"];
  assert.ok(item.prs.every((p) => !p.required && p.acceptedClosure));
  const plan = decideItem(f.state, "issue:7", { authorization: { valid: true, revision: item.revision }, prs: [] }, f.config, { now: at });
  assert.equal(plan.action.mode, "build"); assert.deepEqual(plan.action.commandIds, [request.id]);
  await f.store.transact((s) => evolve(s, "issue:7", reserve("replacement", { mode: "build", revision: item.revision, automatic: false,
    commandIds: [request.id], target: { number: null, branch: "factory/replacement", head: null } })));
  assert.equal(f.state.items["issue:7"].restart.phase, "done");
  assert.equal((await f.restart({ key: "issue:7" })).status, "done");
  assert.equal(f.writes.length, 2);
});

test("a lost close response is recovered before another PR closes or a replacement is admitted", async () => {
  const f = fixture(); await f.command("/agent restart");
  const close = f.write.closePull; let once = true;
  f.write.closePull = async (n) => { await close(n); if (once) { once = false; throw new Error("response lost"); } };
  assert.equal((await f.restart({ key: "issue:7" })).status, "waiting");
  assert.equal(f.state.items["issue:7"].restart.phase, "closing");
  assert.equal((await f.restart({ key: "issue:7" })).status, "ready");
  assert.deepEqual(f.writes, [["close", 9], ["close", 10]]);
});

test("an unknown close remains attached to its restart and is not blindly retried", async () => {
  const f = fixture(); await f.command("/agent restart");
  f.write.closePull = async (n) => { f.writes.push(["close", n]); throw new Error("unknown outcome"); };
  for (let n = 0; n < 3; n++) assert.equal((await f.restart({ key: "issue:7" })).status, "waiting");
  assert.deepEqual(f.writes, [["close", 9]]);
  assert.ok(f.state.items["issue:7"].prs.every((p) => p.required));
});

test("stop after one close allows its receipt but forbids remaining closes and replacement work", async () => {
  const f = fixture(); await f.command("/agent restart");
  const close = f.write.closePull;
  f.write.closePull = async (n) => { await close(n); await f.command("/agent stop"); throw new Error("response lost"); };
  await f.restart({ key: "issue:7" });
  assert.equal((await f.restart({ key: "issue:7" })).status, "superseded");
  assert.deepEqual(f.writes, [["close", 9]]);
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.ok(f.state.items["issue:7"].prs.every((p) => p.required));
});

test("restart invalidates a live worker and cannot close PRs until that owner is terminal", async () => {
  const f = fixture({ live: true }); await f.command("/agent restart");
  assert.equal(f.state.items["issue:7"].generation, 1);
  assert.equal((await f.restart({ key: "issue:7" })).status, "waiting");
  assert.equal(f.writes.length, 0);
  const plan = decideItem(f.state, "issue:7", { prs: [], owner: { id: "100", attempt: 1, status: "in_progress" } }, f.config, { now: at });
  assert.equal(plan.action.type, "cancel-owner");
});

test("a closed issue is explicitly reopened before restart closes its PRs", async () => {
  const f = fixture({ closedIssue: true }); await f.command("/agent restart");
  assert.equal((await f.restart({ key: "issue:7" })).status, "ready");
  assert.deepEqual(f.writes, [["reopen"], ["close", 9], ["close", 10]]);
});

test("a human head change between restart planning and closure is not chased automatically", async () => {
  const f = fixture(); await f.command("/agent restart");
  const close = f.write.closePull;
  f.write.closePull = async (n) => { await close(n); f.prs.get(10).head.sha = C; };
  assert.equal((await f.restart({ key: "issue:7" })).status, "superseded");
  assert.deepEqual(f.writes, [["close", 9]]);
  assert.match(f.state.items["issue:7"].question.reason, /inputs changed/);
});
