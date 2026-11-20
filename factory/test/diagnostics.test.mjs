import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseChecks } from "../lib/diagnostics.mjs";
import { checkFacts } from "../lib/observe.mjs";
import { A, B, C, at } from "./fixtures.mjs";

const log = `  1) test example (ExampleTest)\n     test/example_test.exs:12\n     Assertion with == failed\n     code: assert value == 2\n     left: 1\n     right: 2\n     stacktrace:\n       test/example_test.exs:15: (test)\n\n1 test, 1 failure\n`;
function fixture() {
  const check = { id: 300, name: "test", head_sha: C, status: "completed", conclusion: "failure", started_at: at,
    app: { id: 15368, slug: "github-actions" }, details_url: "https://github.com/ntodd/project/actions/runs/100/job/200" };
  const raw = { sha: C, checkRuns: [check], statuses: [] };
  const job = { id: 200, run_id: 100, run_attempt: 1, head_sha: C, name: "test", status: "completed", conclusion: "failure",
    check_run_url: "https://api.github.com/repos/ntodd/project/check-runs/300", steps: [{ number: 4, status: "completed", conclusion: "failure" }] };
  const run = { id: 100, run_attempt: 1, head_sha: B, repository: { id: 42 }, head_repository: { id: 42 }, head_branch: "topic" };
  const api = { job: async () => job, run: async () => run, stepLog: async () => log, checks: async () => raw };
  const context = { repo: "ntodd/project", repositoryId: "42", defaultBranch: "main", headSha: B };
  const diagnose = (scope = "pr") => diagnoseChecks(api, checkFacts(raw, [{ name: "test", appId: 15368 }], B), raw, context, scope);
  return { check, raw, job, run, api, context, diagnose };
}

test("diagnostic logs belong to the exact check, job, attempt and commit", async () => {
  const f = fixture(), result = await f.diagnose();
  assert.equal(result.failed[0].completeEvidence, true);
  assert.equal(result.failed[0].evidence[0].job, "200");
  assert.equal(result.failed[0].evidence[0].sha, C);
  for (const mutate of [
    (f) => { f.job.head_sha = A; }, (f) => { f.run.repository.id = 99; }, (f) => { f.run.head_repository.id = 99; },
    (f) => { f.run.run_attempt = 2; }, (f) => { f.job.check_run_url = "https://api.github.com/repos/other/repo/check-runs/300"; },
    (f) => { f.run.id = 101; },
    (f) => { f.check.details_url = "https://evil.example/ntodd/project/actions/runs/100/job/200"; },
  ]) {
    const bad = fixture(); mutate(bad);
    assert.equal((await bad.diagnose()).failed[0].completeEvidence, false);
  }
});

test("main failure evidence requires the default branch and every failed step to be classified", async () => {
  const f = fixture();
  assert.equal((await f.diagnose("base")).failed[0].completeEvidence, false);
  f.run.head_branch = "main";
  assert.equal((await f.diagnose("base")).failed[0].completeEvidence, false);
  f.run.head_sha = C;
  assert.equal((await f.diagnose("base")).failed[0].completeEvidence, true);
  f.job.steps.push({ number: 5, status: "completed", conclusion: "failure" });
  f.api.stepLog = async (_job, step) => step === 4 ? log : "An unknown step failed";
  assert.equal((await f.diagnose("base")).failed[0].completeEvidence, false);
});

test("a new check attempt during log retrieval invalidates the earlier diagnostic snapshot", async () => {
  const f = fixture();
  f.api.checks = async () => ({ ...f.raw, checkRuns: [{ ...f.check, id: 301, status: "in_progress", conclusion: null }] });
  const result = await f.diagnose();
  assert.equal(result.state, "pending"); assert.equal(result.failed[0].completeEvidence, false);
});
