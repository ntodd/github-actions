import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stateStore, githubData, canonical, GitHubError, UncertainStateWrite, StateConflict } from "../lib/store.mjs";
import { admit, evolve, revisionOf, recordFactoryApp } from "../lib/protocol.mjs";
import { initial, reserve } from "./fixtures.mjs";
const hash = (value) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
const author = (s, n) => admit(s, { key: `issue:${n}`, revision: revisionOf({ title: `Task ${n}` }), evidence: { sourceId: `label:${n}` } });

// Real parent/ancestor and fast-forward behavior; no workflow or controller
// shortcuts. Fault hooks run precisely at the remote mutation boundary.
function fakeGit() {
  const refs = new Map(), trees = new Map(), blobs = new Map(), commits = new Map();
  let beforeAdvance = null, afterAdvance = null, refFailure = false;
  const contains = (parent, child) => parent === child || (commits.get(child)?.parents ?? []).some((p) => contains(parent, p));
  const api = {
    refs, trees, blobs, commits,
    onBeforeAdvance(fn) { beforeAdvance = fn; },
    onAfterAdvance(fn) { afterAdvance = fn; },
    failRefReads() { refFailure = true; },
    async ref(branch) {
      if (refFailure) throw new Error("GitHub unavailable");
      if (!refs.has(branch)) throw new GitHubError(404, "GET", "ref");
      return refs.get(branch);
    },
    async tree(id) { return structuredClone(trees.get(id)); },
    async blob(id) { return { encoding: "base64", content: blobs.get(id).toString("base64") }; },
    async commit(id) { return commits.get(id); },
    async createTree(entries) {
      const tree = entries.map(({ path, content, mode, type }) => {
        const value = Buffer.from(content), id = hash(content);
        blobs.set(id, value);
        return { path, mode, type, sha: id, size: value.length };
      });
      const id = hash(tree); trees.set(id, { tree, truncated: false }); return id;
    },
    async createCommit(tree, parent, message) {
      const value = { tree: { sha: tree }, parents: parent ? [parent] : [], message };
      const id = hash(value); commits.set(id, value); return id;
    },
    async createRef(branch, id) {
      if (refs.has(branch)) throw new GitHubError(422, "POST", "refs");
      refs.set(branch, id);
    },
    async advance(branch, id) {
      const hook = beforeAdvance; beforeAdvance = null;
      if (hook) await hook(branch, id);
      if (!contains(refs.get(branch), id)) throw new GitHubError(422, "PATCH", "ref");
      refs.set(branch, id);
      const after = afterAdvance; afterAdvance = null;
      if (after) await after(branch, id);
    },
    async contains(parent, child) { return contains(parent, child); },
  };
  return api;
}
const setup = async () => {
  const git = fakeGit(), store = stateStore({ git, repositoryId: "42" });
  await store.initialize();
  return { git, store };
};

test("ledger reads report GET counts for one item and 200 historical operations", async (t) => {
  for (const operations of [0, 200]) {
    const { git, store } = await setup();
    let state = initial();
    if (operations) {
      const prototype = evolve(state, "issue:7", reserve());
      state = structuredClone(prototype); state.operations = {}; state.items["issue:7"].attempts = [];
      for (let i = 1; i <= operations; i++) {
        const id = `op-${i}`, at = new Date(Date.UTC(2026, 10, 12) - i * 86400000).toISOString();
        state.operations[id] = { ...structuredClone(prototype.operations["op-1"]), id, phase: "superseded", createdAt: at };
        state.items["issue:7"].attempts.push({ operation: id, automatic: true, kind: "coding", at });
        state.items["issue:7"].activeOperation = id;
      }
    }
    await store.transact(() => state);
    const requests = [];
    const measured = stateStore({ repositoryId: "42", git: githubData({ token: "read-only", repo: "ntodd/project", fetch: async (url, init) => {
      assert.equal(init.method, "GET"); requests.push(url);
      const path = new URL(url).pathname.split("/git/")[1];
      const [kind, id] = path.split("/");
      const value = kind === "ref" ? { object: { sha: git.refs.get("factory-state") } }
        : kind === "commits" ? git.commits.get(id) : kind === "trees" ? git.trees.get(id)
          : kind === "blobs" ? { encoding: "base64", content: git.blobs.get(id).toString("base64") } : assert.fail(path);
      return Response.json(value);
    } }) });
    assert.equal(Object.keys((await measured.load()).state.operations).length, operations);
    const loadCount = requests.length;
    assert.equal(loadCount, 5 + operations);
    requests.length = 0;
    await measured.transact((s) => s);
    assert.equal(requests.length, loadCount);
    t.diagnostic(`1 item, ${operations} operations: load=${loadCount} GETs; no-op transact=${requests.length} GETs`);
  }
});

test("setup makes an independent data branch; load never recreates lost state", async () => {
  const git = fakeGit(), store = stateStore({ git, repositoryId: "42" });
  await assert.rejects(store.load(), (e) => e.code === "corrupt");
  assert.equal(git.commits.size, 0);
  const start = await store.initialize();
  assert.deepEqual((await store.initialize()).state, start.state);
  assert.deepEqual(git.commits.get(start.tip).parents, []);
  git.refs.delete("factory-state");
  await assert.rejects(store.transact((s) => author(s, 7)), /missing/);
  assert.equal(git.commits.size, 1);
});

test("operations and items round-trip through versioned per-record JSON", async () => {
  const { store, git } = await setup();
  const result = await store.transact(() => evolve(initial(), "issue:7", reserve()));
  const read = await store.load();
  assert.deepEqual(read, result);
  const tree = git.trees.get(git.commits.get(read.tip).tree.sha);
  assert.deepEqual(tree.tree.map((x) => x.path), ["repository.json", "items/issue:7.json", "operations/op-1.json"]);
  const count = git.commits.size;
  await store.transact((s) => s);
  assert.equal(git.commits.size, count, "an unchanged ledger creates no commit");
});

test("the protected repository record preserves the verified App identity and refuses silent replacement", async () => {
  const { store } = await setup(), app = { id: "123", login: "actual-factory[bot]" };
  await store.transact((s) => recordFactoryApp(s, app));
  assert.deepEqual((await store.load()).state.factoryApp, app);
  await assert.rejects(store.transact((s) => recordFactoryApp(s, { id: "999", login: "other[bot]" })), /App changed/);
  await assert.rejects(store.transact((s) => { delete s.factoryApp; return s; }), /Cannot change the recorded factory App/);
  await assert.rejects(store.transact((s) => { s.factoryApp.id = "999"; return s; }), /Cannot change the recorded factory App/);
  assert.deepEqual((await store.load()).state.factoryApp, app);
});

test("conflicting writers reread and recompute rather than erase each other's state", async () => {
  const { store, git } = await setup();
  let calls = 0;
  git.onBeforeAdvance(async () => { await store.transact((s) => author(s, 8)); });
  const result = await store.transact((s) => { calls++; return author(s, 7); });
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(result.state.items).sort(), ["issue:7", "issue:8"]);
  assert.deepEqual((await store.load()).state, result.state);
});

test("a successful state advance with a lost response is recovered without rerunning the mutator", async () => {
  const { store, git } = await setup();
  let calls = 0;
  git.onAfterAdvance(() => { throw new Error("response lost"); });
  const result = await store.transact((s) => { calls++; return author(s, 7); });
  assert.equal(calls, 1);
  assert.equal(result.tip, git.refs.get("factory-state"));
  assert.ok(result.state.items["issue:7"]);
});

test("recovery returns later state if another writer advanced after the ambiguous commit", async () => {
  const { store, git } = await setup();
  git.onAfterAdvance(async () => { await store.transact((s) => author(s, 8)); throw new Error("response lost"); });
  const result = await store.transact((s) => author(s, 7));
  assert.deepEqual(Object.keys(result.state.items).sort(), ["issue:7", "issue:8"]);
});

test("a failed or still-in-flight state request cannot be retried just because the old tip is visible", async () => {
  const { store, git } = await setup();
  const old = git.refs.get("factory-state");
  let calls = 0;
  git.onBeforeAdvance(() => { throw new Error("network failed before the outcome was known"); });
  await assert.rejects(store.transact((s) => { calls++; return author(s, 7); }), (e) => e instanceof UncertainStateWrite && /^[0-9a-f]{40}$/.test(e.commit));
  assert.equal(calls, 1);
  assert.equal(git.refs.get("factory-state"), old);
});

test("failed observation of an ambiguous state write preserves its commit identity", async () => {
  const { store, git } = await setup();
  git.onAfterAdvance(() => { git.failRefReads(); throw new Error("response lost"); });
  await assert.rejects(store.transact((s) => author(s, 7)), (e) => e instanceof UncertainStateWrite && git.refs.get("factory-state") === e.commit);
});

test("a protection rejection with no competing state change is surfaced", async () => {
  const { store, git } = await setup();
  git.onBeforeAdvance(() => { throw new GitHubError(422, "PATCH", "protected state branch"); });
  await assert.rejects(store.transact((s) => author(s, 7)), (e) => e.status === 422);
});

test("state tree, schema, identity and indexes must all validate before any transition", async () => {
  const cases = [
    (tree) => { tree.truncated = true; },
    (tree) => { tree.tree[0].mode = "100755"; },
    (tree) => { tree.tree[0].path = "run.sh"; },
    (tree) => { tree.tree[0].size = 100000000; },
  ];
  for (const corrupt of cases) {
    const { store, git } = await setup();
    const tip = git.refs.get("factory-state");
    corrupt(git.trees.get(git.commits.get(tip).tree.sha));
    await assert.rejects(store.load(), (e) => e.code === "corrupt");
  }
  const { store, git } = await setup();
  const blob = git.trees.get(git.commits.get(git.refs.get("factory-state")).tree.sha).tree[0];
  const value = JSON.parse(git.blobs.get(blob.sha));
  value.items.push("issue:7");
  const content = Buffer.from(canonical(value));
  git.blobs.set(blob.sha, content); blob.size = content.length;
  await assert.rejects(store.load(), /index and records/);
  const other = stateStore({ git, repositoryId: "99" });
  await assert.rejects(other.initialize(), /another repository/);
});

test("unrecognized state files cannot be silently discarded by a new snapshot", async () => {
  const { store, git } = await setup();
  const tree = git.trees.get(git.commits.get(git.refs.get("factory-state")).tree.sha);
  tree.tree.push({ path: "items/issue:99.json", mode: "100644", type: "blob", sha: "a".repeat(40), size: 2 });
  git.blobs.set("a".repeat(40), Buffer.from("{}"));
  await assert.rejects(store.load(), /index and records/);
});

test("GitHub adapter always advances without force and distinguishes commit ancestry", async () => {
  const calls = [];
  const git = githubData({ token: "secret", repo: "ntodd/sandbox", fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/compare/")) return Response.json({ status: "behind" });
    return Response.json({ object: { sha: "a".repeat(40) } });
  } });
  await git.advance("factory-state", "a".repeat(40));
  assert.deepEqual(JSON.parse(calls[0].init.body), { sha: "a".repeat(40), force: false });
  assert.equal(await git.contains("a", "b"), false);
  const refused = githubData({ token: "secret", repo: "ntodd/sandbox", fetch: async () => new Response("secret body", { status: 503 }) });
  await assert.rejects(refused.advance("factory-state", "a"), (e) => e.status === 503 && !e.message.includes("secret"));
});
