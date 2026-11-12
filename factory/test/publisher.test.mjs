import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPublisher } from "../lib/publisher.mjs";
import { validateLedger } from "../lib/protocol.mjs";
import { pending, ready, A, B, C, at } from "./fixtures.mjs";

test("an accepted in-flight push can be recovered while the Actions/artifact API is unavailable", async () => {
  let state = pending(), disposed = 0;
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const actions = { inspect: async () => { throw new Error("Recovery must not depend on the Actions API"); },
    download: async () => { throw new Error("Recovery must not require an expired artifact"); } };
  const publish = cleanPublisher({ api: {}, write: {}, store, actions, repo: "ntodd/project", readToken: "read", writeToken: "write", appLogin: "factory[bot]",
    gitWriter: ({ bundleFile }) => {
      assert.equal(bundleFile, null);
      return { inspect: async () => ({ outcome: "applied", evidence: { kind: "commit-ancestor", commit: C } }),
        apply: async () => { throw new Error("A known push must not be resent"); }, validate: async () => {}, dispose: () => { disposed++; } };
    } });
  assert.equal((await publish({ key: "issue:7", operationId: "op-1", context: {}, run: { id: "900", attempt: 1 } })).status, "done");
  assert.equal(state.operations["op-1"].effects[0].requests.length, 1);
  assert.equal(disposed, 1);
});

test("a runtime conflict withholds new publish intents before artifact or Git access", async () => {
  let state = ready(), calls = 0;
  const store = { load: async () => ({ state }), transact: async (fn) => { state = validateLedger(await fn(state)); return { state }; } };
  const publish = cleanPublisher({ api: {}, write: {}, store, actions: {}, repo: "ntodd/project", readToken: "read", writeToken: "write", appLogin: "factory[bot]",
    assertRuntime: async () => { throw new Error("Legacy runtime conflict"); }, gitWriter: () => { calls++; assert.fail(); } });
  await assert.rejects(publish({ key: "issue:7", operationId: "op-1", context: {}, run: { id: "900", attempt: 1 } }), /Legacy runtime/);
  assert.equal(calls, 0);
  assert.equal(state.operations["op-1"].phase, "result-ready");
  assert.equal(state.operations["op-1"].effects[0].requests.length, 0);
});

test("a former-default proposal is retired before artifact, Git or write access even when the new default has the same commit", async () => {
  let state = ready(), gitCalls = 0, artifactCalls = 0;
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const api = { repository: async () => ({ id: 42, default_branch: "release" }), fileAt: async () => ({ content: "trusted-users: [ntodd]" }),
    branchSha: async (ref) => { assert.notEqual(ref, "main"); return ref === "release" ? A : B; },
    issue: async () => ({ number: 7, state: "open", title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async () => [], reviews: async () => [], threads: async () => [],
    pull: async () => ({ number: 9, state: "open", head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main" } }) };
  const actions = { inspect: async () => { artifactCalls++; assert.fail(); }, download: async () => { artifactCalls++; assert.fail(); } };
  const publish = cleanPublisher({ api, write: {}, store, actions, repo: "ntodd/project", readToken: "read", writeToken: "write", appLogin: "factory[bot]",
    gitWriter: () => { gitCalls++; assert.fail(); } });
  assert.equal((await publish({ key: "issue:7", operationId: "op-1", context: {}, run: { id: "900", attempt: 1 } })).status, "superseded");
  assert.equal(gitCalls, 0); assert.equal(artifactCalls, 0);
  assert.equal(state.operations["op-1"].effects[0].requests.length, 0);
});
