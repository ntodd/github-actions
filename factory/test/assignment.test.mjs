import { test } from "node:test";
import assert from "node:assert/strict";
import { workerAssignment } from "../lib/assignment.mjs";
import { currentWorker } from "../worker/context.mjs";
import { selectProjectSecrets } from "../lib/project-environment.mjs";
import { ingestCommands, resolveRoute } from "../lib/commands.mjs";
import { classifyText } from "../lib/admission.mjs";
import { parseConfig } from "../lib/config.mjs";
import { recordFactoryApp } from "../lib/protocol.mjs";
import { claimed, A, B, at, run } from "./fixtures.mjs";

test("project execution pins environment declarations and rechecks stop, entry and run identity before releasing secrets", async () => {
  const state = recordFactoryApp(claimed(), { id: "123", login: "actual-factory[bot]" });
  const pinned = "trusted-users: [ntodd]\nenvironment: {worker-secrets: [DATABASE_PASSWORD]}";
  const latest = "trusted-users: [ntodd]\nenvironment: {worker-secrets: [DATABASE_PASSWORD, NEW_SECRET]}";
  const C = "c".repeat(40), reads = [];
  const api = {
    workflows: async () => [],
    repository: async () => ({ id: 42, default_branch: "main" }), fileAt: async (_path, ref) => { reads.push(ref); return { content: ref === A ? pinned : latest }; },
    branchSha: async (ref) => ref === "main" ? C : B, run: async () => ({ id: 100, run_attempt: 1, status: "in_progress" }),
    issue: async () => ({ number: 7, state: "open", title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }),
    pull: async () => ({ number: 9, state: "open", head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main" } }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async () => [], threads: async () => [], reviews: async () => [],
  };
  const env = { GITHUB_TOKEN: "read-only", GITHUB_REPOSITORY: "ntodd/project", GITHUB_REPOSITORY_ID: "42", GITHUB_SHA: A,
    GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", FACTORY_ITEM: "issue:7", FACTORY_OPERATION: "op-1",
    RUNNER_TEMP: "/tmp/factory-runner", GITHUB_WORKSPACE: "/tmp/factory-project" };
  const store = { load: async () => ({ state }) };
  const context = await currentWorker({ env, api, store });
  assert.deepEqual(selectProjectSecrets(context.assignment.config.environment, "DATABASE_PASSWORD=known\nNEW_SECRET=not-selected"), { DATABASE_PASSWORD: "known" });
  assert.ok(reads.includes(A) && reads.includes(C));
  assert.equal(context.readToken, "read-only");
  const pull = api.pull;
  for (const patch of [{ base: { ref: "release" } }, { state: "closed" }, { head: { sha: B, ref: "other", repo: { full_name: "ntodd/project" } } },
    { head: { sha: B, ref: "factory/issue-7", repo: { full_name: "elsewhere/project" } } }]) {
    api.pull = async () => ({ ...await pull(), ...patch });
    assert.equal((await context.readFresh()).valid, false);
    await assert.rejects(currentWorker({ env, api, store }), /before project execution/);
  }
  api.pull = pull;
  await assert.rejects(currentWorker({ env: { ...env, GITHUB_SHA: C }, api, store }), /before project execution/);
  await assert.rejects(currentWorker({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, api, store }), /does not own/);
  state.items["issue:7"].paused = true;
  await assert.rejects(currentWorker({ env, api, store }), /before project execution/);
  state.items["issue:7"].paused = false;
  api.workflows = async () => [{ id: 123, path: ".github/workflows/agent-ready.yml", state: "active" }];
  await assert.rejects(context.readFresh(), /legacy agent-ready workflow/);
});

test("a default-branch switch stops project execution even when both branch names resolve to the same commit", async () => {
  const state = claimed(); let defaultBranch = "main";
  const api = {
    workflows: async () => [], repository: async () => ({ id: 42, default_branch: defaultBranch }),
    fileAt: async () => ({ content: "trusted-users: [ntodd]\nenvironment: {worker-secrets: [DATABASE_PASSWORD]}" }),
    branchSha: async (ref) => ref === defaultBranch ? A : B,
    run: async () => ({ id: 100, run_attempt: 1, status: "in_progress" }),
    issue: async () => ({ number: 7, state: "open", title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }),
    pull: async () => ({ number: 9, state: "open", head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main" } }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async () => [], threads: async () => [], reviews: async () => [],
  };
  const env = { GITHUB_TOKEN: "read-only", GITHUB_REPOSITORY: "ntodd/project", GITHUB_REPOSITORY_ID: "42", GITHUB_SHA: A,
    GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", FACTORY_ITEM: "issue:7", FACTORY_OPERATION: "op-1",
    RUNNER_TEMP: "/tmp/factory-runner", GITHUB_WORKSPACE: "/tmp/factory-project" };
  const store = { load: async () => ({ state }) }, context = await currentWorker({ env, api, store });
  defaultBranch = "release";
  assert.equal((await context.readFresh()).valid, false);
  await assert.rejects(currentWorker({ env, api, store }), /before project execution/);
});

test("a routed stop remains visible to the worker across a controller crash before applyControls", async () => {
  let state = claimed(), comments = [];
  const config = parseConfig("trusted-users: [ntodd]");
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }),
    fileAt: async () => ({ content: "trusted-users: [ntodd]" }), branchSha: async (ref) => ref === "main" ? A : B,
    run: async () => ({ id: 100, run_attempt: 1, status: "in_progress" }),
    issue: async () => ({ number: 7, state: "open", title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }),
    pull: async () => ({ number: 9, state: "open", head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main" } }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async (n) => n === 7 ? comments : [], reviews: async () => [], threads: async () => [],
  };
  const { readFresh } = await workerAssignment({ api, store: { load: async () => ({ state }) }, repo: "ntodd/project",
    repositoryId: "42", itemKey: "issue:7", operationId: "op-1", run });
  assert.equal((await readFresh()).paused, false);
  comments = [{ id: 999, body: "@ntodd-agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  state = ingestCommands(state, "issue:7", [classifyText(comments[0], "issue-comment", config, { target: 7 })]);
  state = resolveRoute(state, "issue:7", Object.keys(state.items["issue:7"].commands)[0], "stop");
  assert.equal(state.items["issue:7"].paused, false);
  assert.equal((await readFresh()).paused, true);
  comments = [];
  assert.equal((await readFresh()).paused, false);
});

test("worker context takes App identity from protected state across config changes", async () => {
  let state = recordFactoryApp(claimed(), { id: "123", login: "actual-factory[bot]" });
  const text = "trusted-users: [ntodd]\nhandle: unrelated\nreview-bots: ['actual-factory[bot]']";
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }), fileAt: async () => ({ content: text }),
    branchSha: async (ref) => ref === "main" ? A : B, run: async () => ({ id: 100, run_attempt: 1, status: "in_progress" }),
    issue: async () => ({ number: 7, state: "open", title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }),
    pull: async () => ({ number: 9, state: "open", head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main" } }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async () => [], threads: async () => [], reviews: async (number) => number === 9 ? [{ id: 998, author: "actual-factory[bot]",
      body: "/agent respond more work", state: "CHANGES_REQUESTED", commitSha: B, lastEditedAt: null, createdAt: at }] : [],
  };
  const { assignment, readFresh } = await workerAssignment({ api, store: { load: async () => ({ state }) }, repo: "ntodd/project",
    repositoryId: "42", itemKey: "issue:7", operationId: "op-1", run });
  assert.equal(assignment.config.factoryAppLogin, "actual-factory[bot]");
  const fresh = await readFresh();
  assert.equal(fresh.valid, true);
  assert.equal(fresh.feedback.filter((f) => f.sourceId === "review:998").every((f) => f.authority === "data" && !f.command), true);
  delete state.factoryApp;
  assert.equal((await readFresh()).valid, false);
});
