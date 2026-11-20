import { test } from "node:test";
import assert from "node:assert/strict";
import { publisherWriter } from "../lib/writer.mjs";
import { publishOperation } from "../lib/publish.mjs";
import { threadTargets, threadRevision, threadEffectId } from "../lib/threads.mjs";
import { validateLedger } from "../lib/protocol.mjs";
import { initial, step, reserve, run, provenance, observation, artifact, proposal, B, C, at, operation } from "./fixtures.mjs";

const fact = (id = 101) => ({ sourceId: `review-comment:${id}`, revision: String(id % 10).repeat(64), author: "ntodd",
  authority: "instruction", target: 9, thread: "T1", requiresResponse: true, body: "Fix the boundary condition" });
function fixture({ code = true, own = false, images = [] } = {}) {
  let facts = [fact()], head = B, posts = 0, resolves = 0, loseReply = false, loseResolve = false, afterReply;
  let state = step(initial(), reserve("op-1", { threadTargets: threadTargets(facts, 9), feedbackInputs: facts.map(({ sourceId, revision }) => ({ sourceId, revision })) }));
  if (own) state.items["issue:7"].evidence.own = true;
  state = step(state, { type: "claim", run, provenance, observation });
  state = step(state, { type: "owner-observed", run, status: "completed", conclusion: "success" });
  const result = { ...proposal, outcome: code ? "ready" : "no-change", effects: code ? proposal.effects : [], attachments: images,
    replies: [{ thread: "T1", revision: threadRevision(facts), body: "Fixed the boundary case and added a regression test." + (images.length ? "\n![Phone](./screenshots/ui.png)" : ""), resolve: true }] };
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const remote = { id: "T1", isResolved: false, comments: [] }, calls = [];
  const read = { threads: async () => [remote], pull: async () => ({ state: "open", user: { login: "ntodd-agent[bot]" },
    head: { ref: "factory/issue-7", sha: head, repo: { full_name: "ntodd/project" } } }) };
  const git = { validate: async () => {}, inspect: async () => ({ outcome: "unknown" }), dispose() {},
    apply: async () => { calls.push("push"); head = C; return { outcome: "applied", evidence: { kind: "branch-head", commit: C } }; } };
  const api = {
    replyThread: async (_id, body) => {
      posts++; calls.push("reply"); const comment = { id: "RC_reply", nodeId: "RC_reply", body, author: "ntodd-agent[bot]", pullRequest: { number: 9 } };
      remote.comments.push(comment); if (afterReply) await afterReply();
      if (loseReply) throw new Error("reply response lost"); return comment;
    },
    resolveThread: async () => { resolves++; calls.push("resolve"); remote.isResolved = true;
      if (loseResolve) throw new Error("resolve response lost"); return { id: "T1", isResolved: true, pullRequest: { number: 9 } }; },
  };
  const args = { store, writer: publisherWriter({ git, api, read, repo: "ntodd/project", appLogin: "ntodd-agent[bot]",
    attachments: { validate: async () => {}, inspect: async () => ({ outcome: "unknown" }), apply: async (e) => {
      calls.push("attachment"); return { outcome: "applied", evidence: { kind: "attachment", repositoryId: "42", digest: e.digest, size: e.size,
        url: "https://github.com/user-attachments/assets/12345678-abcd-1234-abcd-123456789abc" } };
    } } }),
    itemKey: "issue:7", operationId: "op-1", publisherRun: { id: "900", attempt: 1 }, now: () => at,
    observe: async () => ({ ...observation, head, threadRevisions: { T1: threadRevision(facts) } }) };
  return { store, read, result, calls, remote, args, get state() { return state; }, get posts() { return posts; }, get resolves() { return resolves; },
    collect: async (extra = {}) => store.transact((s) => step(s, { type: "collect-result", artifact, proposal: result, feedback: facts, ...extra })),
    addFact(value = fact(102)) { facts.push(value); }, loseReply() { loseReply = true; }, loseResolve() { loseResolve = true; },
    afterReply(fn) { afterReply = fn; } };
}

test("review screenshots upload before reply and resolution with or without a code push", async () => {
  const images = [{ file: `screenshot-${"e".repeat(64)}.png`, digest: `sha256:${"e".repeat(64)}`, size: 100,
    paths: ["./screenshots/ui.png"], contentType: "image/png" }];
  for (const code of [true, false]) {
    const f = fixture({ code, images }); await f.collect();
    assert.equal((await publishOperation(f.args)).status, "done");
    assert.deepEqual(f.calls, [...(code ? ["push"] : []), "attachment", "reply", "resolve"]);
    assert.match(f.remote.comments[0].body, /!\[Phone\]\(https:\/\/github.com\/user-attachments\/assets\//);
    assert.equal(f.remote.comments[0].body.includes("./screenshots/"), false);
  }
});

test("code publishes before its reply, which publishes before resolution and feedback consumption", async () => {
  const f = fixture(); await f.collect();
  assert.equal(f.state.items["issue:7"].feedback, undefined);
  assert.equal((await publishOperation(f.args)).status, "done");
  assert.deepEqual(f.calls, ["push", "reply", "resolve"]);
  assert.equal(f.state.items["issue:7"].feedback["review-comment:101"], fact().revision);
  assert.ok(operation(f.state).effects.every((e) => e.status === "applied"));
});
test("a no-code response can reply and resolve without a bundle or code push", async () => {
  const f = fixture({ code: false }); await f.collect();
  assert.equal((await publishOperation(f.args)).status, "done");
  assert.deepEqual(f.calls, ["reply", "resolve"]);
});
test("thread and PR validation read failures back off without recording a reply or discarding its proposal", async () => {
  for (const method of ["threads", "pull"]) {
    const f = fixture({ code: false }); await f.collect();
    const original = f.read[method]; let time = at, reads = 0;
    f.args.now = () => time; f.read[method] = async () => { reads++; throw new Error("connection interrupted"); };
    await assert.rejects(publishOperation(f.args), (e) => e.code === "read-unavailable");
    assert.equal(operation(f.state).publishError, undefined);
    assert.equal(operation(f.state).effects[0].requests.length, 0); assert.equal(f.posts, 0);
    assert.equal((await publishOperation(f.args)).status, "waiting"); assert.equal(reads, 1);
    time = "2026-11-12T12:01:00Z"; f.read[method] = original;
    assert.equal((await publishOperation(f.args)).status, "done");
    assert.equal(f.posts, 1); assert.equal(f.resolves, 1);
  }
});
test("a lost reply response is recovered from its exact App marker rather than posting another reply", async () => {
  const f = fixture(); await f.collect(); f.loseReply();
  assert.equal((await publishOperation(f.args)).status, "waiting");
  assert.equal((await publishOperation(f.args)).status, "done");
  assert.equal(f.posts, 1); assert.equal(f.resolves, 1);
});
test("a lost resolution response is recovered from the thread and can finish after stop", async () => {
  const f = fixture(); await f.collect(); f.loseResolve();
  assert.equal((await publishOperation(f.args)).status, "waiting");
  await f.store.transact((s) => step(s, { type: "stop" }));
  assert.equal((await publishOperation(f.args)).status, "done");
  assert.equal(f.resolves, 1); assert.equal(f.state.items["issue:7"].paused, true);
});
test("stop after a lost reply permits receipt recovery but forbids a new resolution request", async () => {
  const f = fixture(); await f.collect(); f.loseReply();
  await publishOperation(f.args); await f.store.transact((s) => step(s, { type: "stop" }));
  assert.equal((await publishOperation(f.args)).status, "superseded");
  assert.equal(f.posts, 1); assert.equal(f.resolves, 0);
  assert.equal(operation(f.state).effects.find((e) => e.id === threadEffectId("reply", "T1")).status, "applied");
  assert.equal(f.state.items["issue:7"].feedback, undefined);
});
test("unassigned threads, changed snapshots, own-PR metadata and untrusted anchors are rejected", async () => {
  for (const change of ["foreign", "changed", "own", "untrusted"]) {
    const f = fixture({ own: change === "own" });
    if (change === "foreign") f.result.replies[0].thread = "T2";
    if (change === "changed") f.addFact();
    const extra = change === "untrusted" ? { feedback: [{ ...fact(), authority: "data" }] } : {};
    await assert.rejects(() => f.collect(extra), (e) => e.code === "invalid-result");
    assert.equal(f.posts, 0);
  }
});
test("a correction read during work can be accepted against the fresh API snapshot and consumed with its reply", async () => {
  const f = fixture(), next = fact(102); f.addFact(next);
  f.result.replies[0].revision = threadRevision([fact(), next]);
  await f.collect();
  assert.equal((await publishOperation(f.args)).status, "done");
  assert.equal(f.state.items["issue:7"].feedback[next.sourceId], next.revision);
});
test("new discussion after the reply keeps the thread open and does not consume unfinished feedback", async () => {
  const f = fixture(); await f.collect(); f.afterReply(() => f.addFact());
  assert.equal((await publishOperation(f.args)).status, "superseded");
  assert.equal(f.posts, 1); assert.equal(f.resolves, 0);
  assert.equal(f.state.items["issue:7"].feedback, undefined);
});

test("an omitted assigned thread is not marked handled just because the worker ended", async () => {
  const f = fixture({ code: false }); f.result.replies = [];
  await f.collect(); await publishOperation(f.args);
  assert.equal(f.state.items["issue:7"].feedback?.[fact().sourceId], undefined);
  assert.equal(f.posts, 0);
});
