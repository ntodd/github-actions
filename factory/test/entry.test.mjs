import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEntry } from "../lib/entry.mjs";
import { A } from "./fixtures.mjs";
const context = { defaultBranch: "main", repositoryId: "42" };
const env = { GITHUB_REPOSITORY: "ntodd/project", GITHUB_WORKFLOW_REF: "ntodd/project/.github/workflows/factory.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: A };
const actual = { id: 100, run_attempt: 1, path: ".github/workflows/factory.yml", repository: { id: 42 }, head_repository: { id: 42 }, head_sha: A, head_branch: "main", status: "in_progress" };
test("privileged entry rejects a PR review or non-default caller before requesting run facts", async () => {
  let calls = 0;
  const api = { run: async () => { calls++; return actual; } };
  await assert.rejects(() => verifyEntry({ api, context, env: { ...env, GITHUB_EVENT_NAME: "pull_request_review" } }), /default-branch/);
  await assert.rejects(() => verifyEntry({ api, context, env: { ...env, GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace("heads/main", "heads/topic") } }), /default-branch/);
  assert.equal(calls, 0);
  assert.equal((await verifyEntry({ api, context, env })).id, 100);
});
test("the server's workflow attempt, repository, branch and commit must match the entry", async () => {
  for (const changed of [{ path: ".github/workflows/other.yml" }, { head_sha: "b".repeat(40) }, { run_attempt: 2 },
    { head_branch: "topic" }, { head_repository: { id: 99 } }, { status: "completed" }]) {
    await assert.rejects(() => verifyEntry({ api: { run: async () => ({ ...actual, ...changed }) }, context, env }), /identity/);
  }
});
