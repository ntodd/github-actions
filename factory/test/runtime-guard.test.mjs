import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRuntimeIsolation, LIVE_RUN_STATUSES, LEGACY_WORKFLOW, RuntimeConflict } from "../lib/runtime-guard.mjs";
import { readClient } from "../lib/github.mjs";

const legacy = { id: 123, path: LEGACY_WORKFLOW, state: "disabled_manually" };

test("legacy reusable callers must also be disabled with no live runs", async () => {
  const caller = { id: 124, path: ".github/workflows/agent-ready-caller.yml", state: "active" };
  const seen = [];
  const api = { workflows: async () => [legacy, caller], repository: async () => ({ default_branch: "main" }),
    branchSha: async () => "a".repeat(40), fileAt: async (_path, sha) => {
      assert.equal(sha, "a".repeat(40));
      return { content: "on: issue_comment\njobs:\n  agent:\n    uses: ntodd/github-actions/.github/workflows/agent-ready.yml@main\n" };
    }, liveWorkflowRuns: async (id) => { seen.push(id); return []; } };
  await assert.rejects(assertRuntimeIsolation(api), /agent-ready-caller.yml.*disable/);
  caller.state = "disabled_manually"; seen.length = 0;
  await assertRuntimeIsolation(api);
  assert.deepEqual(seen, [123, 124]);
  api.liveWorkflowRuns = async (id) => id === 124 ? [{ id: 99, status: "queued" }] : [];
  await assert.rejects(assertRuntimeIsolation(api), /still has live/);
});
test("an enabled, unknown or malformed legacy runtime cannot coexist with active factory work", async () => {
  for (const rows of [[{ ...legacy, state: "active" }], [{ ...legacy, state: "new-state" }], [{ ...legacy, id: null }], [legacy, legacy], null]) {
    await assert.rejects(assertRuntimeIsolation({ workflows: async () => rows,
      liveWorkflowRuns: async () => { throw new Error("Do not inspect runs before a disabled workflow is established"); } }), RuntimeConflict);
  }
});

test("disabled workflows need known absence of every live run; failures remain unknown", async () => {
  await assertRuntimeIsolation({ workflows: async () => [], liveWorkflowRuns: async () => assert.fail() });
  let calls = 0;
  await assertRuntimeIsolation({ workflows: async () => [legacy], liveWorkflowRuns: async (id) => { calls++; assert.equal(id, 123); return []; } });
  assert.equal(calls, 1);
  for (const status of LIVE_RUN_STATUSES) await assert.rejects(assertRuntimeIsolation({ workflows: async () => [legacy],
    liveWorkflowRuns: async () => [{ id: 99, status }] }), /still has live/);
  await assert.rejects(assertRuntimeIsolation({ workflows: async () => [legacy], liveWorkflowRuns: async () => { throw new Error("API unavailable"); } }), /unavailable/);
});

test("filtered server counts establish absence without scanning completed history", async () => {
  const seen = [];
  const client = readClient({ token: "read-only", repo: "ntodd/project", fetch: async (url, init) => {
    seen.push(url); assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ total_count: 0, workflow_runs: [] });
  } });
  assert.deepEqual(await client.liveWorkflowRuns(123), []);
  assert.deepEqual(seen.map((u) => new URL(u).searchParams.get("status")).sort(), [...LIVE_RUN_STATUSES].sort());
  assert.ok(seen.every((u) => new URL(u).searchParams.get("per_page") === "1"));
  for (const data of [{ workflow_runs: [] }, { total_count: 1, workflow_runs: [] }, { total_count: 0, workflow_runs: [{ id: 1 }] }]) {
    const broken = readClient({ token: "read-only", repo: "ntodd/project", fetch: async () => Response.json(data) });
    await assert.rejects(broken.liveWorkflowRuns(123), /Incomplete/);
  }
});

test("workflow inventory is fully paginated and a nonzero run count blocks even when its example has just finished", async () => {
  const client = readClient({ token: "read-only", repo: "ntodd/project", fetch: async (url) => {
    if (url.includes("status=")) return Response.json({ total_count: 5000, workflow_runs: [{ id: 100, status: "completed" }] });
    if (url.includes("page=2")) return Response.json({ workflows: [legacy] });
    return Response.json({ workflows: [] }, { headers: { link: '<https://api.github.com/repos/ntodd/project/actions/workflows?page=2>; rel="next"' } });
  } });
  assert.deepEqual(await client.workflows(), [legacy]);
  await assert.rejects(assertRuntimeIsolation(client), /still has live/);
});
