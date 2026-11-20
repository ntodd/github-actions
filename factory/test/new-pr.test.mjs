import { test } from "node:test";
import assert from "node:assert/strict";
import { publisherWriter } from "../lib/writer.mjs";
import { publishOperation } from "../lib/publish.mjs";
import { pullRequestText } from "../lib/effects.mjs";
import { initial, step, reserve, run, provenance, artifact, observation, A, C, at, operation } from "./fixtures.mjs";
function readyBuild() {
  let s = step(initial(), reserve("op-1", { mode: "build", target: { number: null, branch: "factory/issue-7", head: null } }));
  s = step(s, { type: "claim", run, provenance, observation: { ...observation, head: null } });
  s = step(s, { type: "owner-observed", run, status: "completed", conclusion: "success" });
  return step(s, { type: "collect-result", artifact, proposal: { schemaVersion: 1, operationId: "op-1", run, outcome: "ready", effects: [
    { id: "push", type: "push", branch: "factory/issue-7", expectedHead: null, commit: C, baseSha: A },
  ], pullRequest: { title: "Fix the race", body: "Issue: #7\n\nTests passed." } } });
}
function fixture() {
  let state = readyBuild(), remoteHead = null, prs = [], creates = 0, loseResponse = false;
  const store = { load: async () => ({ state: structuredClone(state) }),
    transact: async (fn) => { state = await fn(state); return { state: structuredClone(state) }; } };
  const git = { validate: async () => {}, inspect: async (e) => remoteHead === e.commit ? { outcome: "applied", evidence: { kind: "branch-head", commit: C } } : { outcome: "unknown" },
    apply: async () => { remoteHead = C; return { outcome: "applied", evidence: { kind: "branch-head", commit: C } }; }, dispose() {} };
  const api = { pullsForBranch: async () => prs, createPull: async (data) => {
    creates++;
    const pr = { ...data, number: 12, state: "open", head: { ref: data.head, repo: { full_name: "ntodd/repo" } }, base: { ref: data.base }, user: { login: "ntodd-agent[bot]" } };
    prs.push(pr);
    if (loseResponse) throw new Error("lost response after PR creation");
    return pr;
  } };
  return { store, api, writer: publisherWriter({ git, api, repo: "ntodd/repo", appLogin: "ntodd-agent[bot]" }),
    itemKey: "issue:7", operationId: "op-1", publisherRun: { id: "900", attempt: 1 }, now: () => at,
    observe: async () => ({ ...observation, head: remoteHead }),
    creations: () => creates, loseResponse() { loseResponse = true; }, prs: () => prs };
}

test("a new PR depends on its push and becomes recorded membership from a validated receipt", async () => {
  const f = fixture();
  assert.equal((await publishOperation(f)).status, "done");
  const s = (await f.store.load()).state;
  assert.equal(operation(s).effects.length, 2);
  assert.equal(s.items["issue:7"].prs.find((p) => p.number === 12).required, true);
  assert.equal(f.creations(), 1);
});

test("a PR created before a lost response is recovered without opening another", async () => {
  const f = fixture(); f.loseResponse();
  assert.equal((await publishOperation(f)).status, "waiting");
  assert.equal((await publishOperation(f)).status, "done");
  assert.equal(f.creations(), 1);
});

test("a PR lookup outage preserves the applied push and retries the read before one PR create", async () => {
  const f = fixture(), lookup = f.api.pullsForBranch; let time = at, reads = 0;
  f.now = () => time;
  f.api.pullsForBranch = async () => { reads++; throw new Error("connection interrupted"); };
  await assert.rejects(publishOperation(f), (e) => e.code === "read-unavailable");
  let op = operation((await f.store.load()).state);
  assert.equal(op.effects[0].status, "applied"); assert.equal(op.effects[1].requests.length, 0);
  assert.equal(op.publishError, undefined); assert.equal(f.creations(), 0);
  assert.equal((await publishOperation(f)).status, "waiting"); assert.equal(reads, 1);
  time = "2026-11-12T12:01:00Z"; f.api.pullsForBranch = lookup;
  assert.equal((await publishOperation(f)).status, "done"); assert.equal(f.creations(), 1);
  op = operation((await f.store.load()).state);
  assert.equal(op.effects[0].requests.length, 1); assert.equal(op.effects[1].requests.length, 1);
});

test("an unrelated PR remains a validation defect rather than a retryable lookup outage", async () => {
  const f = fixture(); f.api.pullsForBranch = async () => [{ state: "open", head: { ref: "unrelated" } }];
  await assert.rejects(publishOperation(f), /unrelated PR/);
  const state = (await f.store.load()).state;
  assert.match(operation(state).publishError.reason, /unrelated PR/);
  assert.equal(state.items["issue:7"].preflights, undefined); assert.equal(f.creations(), 0);
});

test("PR membership cannot be established from an unrequested PR or an effect before its push", () => {
  const s = step(readyBuild(), { type: "authorize-publish", observation: { ...observation, head: null } });
  assert.throws(() => step(s, { type: "request-effect", effectId: "pull-request", observation: { ...observation, head: C } }), (e) => e.code === "pending");
});

test("PR prose cannot silently close issues before aggregate completion", () => {
  for (const body of ["Fixes #7", "Resolves owner/repo#8", "closes: https://github.com/owner/repo/issues/9"]) assert.throws(() => pullRequestText({ title: "Fix", body }), /completion/);
  assert.equal(pullRequestText({ title: "Fix", body: "Issue: #7" }).body, "Issue: #7");
});

test("restart after a successful branch push retires the remaining PR create without losing the push receipt", async () => {
  const f = fixture(), original = f.writer.apply.bind(f.writer);
  f.writer.apply = async (effect, op) => {
    const result = await original(effect, op);
    if (effect.type === "push") await f.store.transact((s) => step(s, { type: "stop" }));
    return result;
  };
  assert.equal((await publishOperation(f)).status, "superseded");
  const op = operation((await f.store.load()).state);
  assert.equal(op.effects[0].status, "applied");
  assert.equal(op.effects[0].receipt.commit, C);
  assert.equal(op.effects[1].requests.length, 0);
  assert.equal(f.creations(), 0);
});

test("a delayed push receipt clears its own deadline question and can finish the original PR publication", async () => {
  const f = fixture(), apply = f.writer.apply.bind(f.writer); let pushes = 0;
  f.writer.apply = async (effect, op) => {
    const result = await apply(effect, op);
    if (effect.type === "push") { pushes++; throw new Error("Push receipt lost"); }
    return result;
  };
  assert.equal((await publishOperation(f)).status, "waiting");
  await f.store.transact((s) => step(s, { type: "ask", reason: "Inspect the unknown push", kind: "publish-outcome",
    recovery: { operation: "op-1", effect: "push", request: "op-1/push/1" } }));
  f.writer.apply = apply;
  assert.equal((await publishOperation(f)).status, "done");
  assert.equal((await f.store.load()).state.items["issue:7"].question, null);
  assert.equal(pushes, 1); assert.equal(f.creations(), 1);
});
