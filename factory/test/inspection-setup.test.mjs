import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readAppInspection } from "../lib/app-inspection.mjs";
import { actionsClient, resultFiles } from "../lib/actions.mjs";
import { callerWorkflow } from "../lib/caller.mjs";
import { A, B, C, at } from "./fixtures.mjs";
import { zip } from "./archive-fixture.mjs";

const permissions = { contents: "write", issues: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read" };
function fixture() {
  const repository = { id: 42, full_name: "ntodd/project", default_branch: "main", permissions: { admin: true }, owner: { login: "ntodd", type: "User" } };
  const report = { schemaVersion: 1, observedAt: at, actor: "ntodd", repository: { id: "42", fullName: "ntodd/project", defaultBranch: "main", headSha: A },
    tooling: { repository: "ntodd/github-actions", sha: B }, run: { id: "100", attempt: 1 },
    app: { id: 123, slug: "factory-app", permissions: { ...permissions } },
    installation: { id: 7, app_id: 123, permissions: { ...permissions }, repository_selection: "selected", suspended_at: null } };
  const run = { id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 }, path: ".github/workflows/factory.yml",
    head_branch: "main", head_sha: A, event: "workflow_dispatch", actor: { login: "ntodd" }, triggering_actor: { login: "ntodd" },
    status: "completed", conclusion: "success", run_started_at: "2026-11-12T11:59:00Z", updated_at: "2026-11-12T12:01:00Z",
    referenced_workflows: [{ path: `ntodd/github-actions/.github/workflows/factory-runtime.yml@${B}`, sha: B }] };
  const jobs = [{ id: 200, name: "factory / factory-control", run_id: 100, run_attempt: 1, head_sha: A, status: "completed", conclusion: "success",
    steps: [{ name: "Upload public App inspection metadata", status: "completed", conclusion: "success" }] },
  { name: "factory / factory-worker", status: "completed", conclusion: "skipped" }, { name: "factory / factory-update", status: "completed", conclusion: "skipped" }];
  const archive = () => zip([["factory-app-inspection.json", JSON.stringify(report)]], { descriptor: true });
  const artifact = { id: 300, name: "factory-inspection-100-1", expired: false, created_at: at, expires_at: "2026-11-13T12:00:00Z",
    workflow_run: { id: 100, repository_id: 42, head_repository_id: 42, head_sha: A, head_branch: "main" } };
  const downloads = [], api = { repository: async () => repository, branchSha: async () => A,
    fileAt: async (path, sha) => {
      assert.equal(sha, A);
      return path === ".github/workflows/factory.yml" ? callerWorkflow({ defaultBranch: "main", ciWorkflows: ["CI"], ref: B }) : "trusted-users: [ntodd]";
    }, run: async (id, attempt) => { assert.equal(id, "100"); assert.equal(attempt, 1); return run; },
    jobs: async () => jobs, artifacts: async () => [{ size_in_bytes: archive().length,
      digest: `sha256:${createHash("sha256").update(archive()).digest("hex")}`, ...artifact }],
    variable: async () => ({ value: "123" }), secretNames: async () => ["AGENT_APP_PRIVATE_KEY"] };
  const fetch = async (url, options) => {
    downloads.push({ url, options });
    if (url === "https://api.github.com/repos/ntodd/project/actions/artifacts/300/zip") return new Response(null, { status: 302, headers: { location: "https://objects.example/report?signature=opaque" } });
    assert.equal(url, "https://objects.example/report?signature=opaque");
    assert.equal(options.headers, undefined);
    return new Response(archive());
  };
  const actions = actionsClient({ token: "administrator-token", repo: "ntodd/project", fetch });
  return { repository, report, run, jobs, artifact, api, actions, archive, downloads,
    execute: (extra = {}) => readAppInspection({ api, actions, repository, runId: "100", toolingSha: B, ciWorkflows: ["CI"],
      now: () => "2026-11-12T12:02:00Z", ...extra }) };
}

test("administrator setup verifies App inspection provenance and uses public metadata without a local key", async () => {
  const f = fixture(); f.report.app.private_key = "must-not-escape"; f.report.installation.access_token = "must-not-escape";
  const result = await f.execute();
  assert.equal(result.app.id, 123); assert.equal(result.installation.id, 7);
  assert.deepEqual(result.provenance.run, { id: "100", attempt: 1 });
  assert.equal(result.provenance.artifact.id, "300"); assert.equal(result.provenance.toolingSha, B);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.equal(f.downloads.length, 2);
  assert.equal(f.downloads[0].options.headers.authorization, "Bearer administrator-token");
  assert.equal(f.downloads[1].options.headers, undefined);
});

test("inspection accepts the optional attachment credential contract while rejecting a substituted secret", async () => {
  const f = fixture(), original = f.api.fileAt;
  f.api.fileAt = async (path, sha) => path === ".github/workflows/factory.yml"
    ? callerWorkflow({ defaultBranch: "main", ciWorkflows: ["CI"], ref: B, attachments: true }) : original(path, sha);
  assert.equal((await f.execute()).app.id, 123);
  const caller = f.api.fileAt;
  f.api.fileAt = async (path, sha) => (await caller(path, sha)).replace("AGENT_ATTACH_TOKEN }}", "AGENT_APP_PRIVATE_KEY }}");
  await assert.rejects(f.execute(), /current generated read-only caller/);
});

test("inspection identity requires the owner, current caller commit and actual pinned reusable workflow", async () => {
  for (const change of [
    (f) => { f.repository.permissions.admin = false; }, (f) => { f.repository.owner.type = "Organization"; },
    (f) => { f.run.actor.login = "collaborator"; }, (f) => { f.run.triggering_actor.login = "collaborator"; },
    (f) => { f.run.event = "pull_request"; }, (f) => { f.run.path = ".github/workflows/forged.yml"; },
    (f) => { f.run.head_repository.id = 43; }, (f) => { f.run.repository.id = 43; }, (f) => { f.run.head_sha = C; },
    (f) => { f.run.head_branch = "other"; }, (f) => { f.run.run_attempt = 2; }, (f) => { f.run.status = "in_progress"; },
    (f) => { f.run.conclusion = "failure"; }, (f) => { f.run.referenced_workflows = []; },
    (f) => { f.run.referenced_workflows[0].sha = C; }, (f) => { f.run.referenced_workflows[0].path = `attacker/project/.github/workflows/factory-runtime.yml@${B}`; },
    (f) => { f.api.fileAt = async () => callerWorkflow({ defaultBranch: "main", ciWorkflows: ["CI"], ref: B, dryRun: false }); },
  ]) { const f = fixture(); change(f); await assert.rejects(f.execute()); assert.equal(f.downloads.length, 0); }
});

test("inspection setup requires a successful inspection upload with no executed project job", async () => {
  for (const change of [
    (f) => { f.jobs[0].head_sha = C; }, (f) => { f.jobs[0].run_attempt = 2; }, (f) => { f.jobs[0].run_id = 101; },
    (f) => { f.jobs[0].conclusion = "failure"; }, (f) => { f.jobs[0].steps = []; },
    (f) => { f.jobs[0].steps[0].conclusion = "skipped"; }, (f) => { f.jobs.push(f.jobs[0]); },
    (f) => { f.jobs[1].conclusion = "success"; }, (f) => { f.jobs[2].conclusion = "cancelled"; },
  ]) { const f = fixture(); change(f); await assert.rejects(f.execute()); assert.equal(f.downloads.length, 0); }
});

test("expired, substituted and duplicate inspection artifacts never establish an App identity", async () => {
  for (const change of [
    (f) => { f.artifact.expired = true; }, (f) => { f.artifact.expires_at = at; }, (f) => { f.artifact.created_at = "2026-11-11T12:00:00Z"; },
    (f) => { f.artifact.name = "factory-inspection-100-2"; }, (f) => { f.artifact.workflow_run.head_sha = C; },
    (f) => { f.artifact.workflow_run.repository_id = 43; }, (f) => { f.artifact.workflow_run.head_repository_id = 43; },
    (f) => { f.artifact.workflow_run.id = 101; }, (f) => { f.artifact.workflow_run.head_branch = "other"; },
    (f) => { f.artifact.size_in_bytes = 128 * 1024 + 1; }, (f) => { f.artifact.digest = `sha256:${"0".repeat(64)}`; },
    (f) => { const list = f.api.artifacts; f.api.artifacts = async () => { const rows = await list(); return [...rows, ...rows]; }; },
  ]) { const f = fixture(); change(f); await assert.rejects(f.execute()); }
});

test("inspection report fields, current App variable and both permission grants must agree", async () => {
  for (const change of [
    (f) => { f.report.run.attempt = 2; }, (f) => { f.report.run.id = "101"; }, (f) => { f.report.repository.id = "43"; },
    (f) => { f.report.repository.headSha = C; }, (f) => { f.report.tooling.sha = C; }, (f) => { f.report.actor = "collaborator"; },
    (f) => { f.report.observedAt = "2026-11-11T12:00:00Z"; }, (f) => { f.report.observedAt = "2026-11-12T13:00:00Z"; },
    (f) => { f.report.schemaVersion = 2; }, (f) => { f.report.app.id = 456; }, (f) => { f.api.variable = async () => ({ value: "456" }); },
    (f) => { f.api.secretNames = async () => []; }, (f) => { f.report.installation.app_id = 456; },
    (f) => { f.report.installation.suspended_at = at; }, (f) => { f.report.app.permissions.administration = "write"; },
    (f) => { f.report.installation.permissions.contents = "read"; },
  ]) { const f = fixture(); change(f); await assert.rejects(f.execute()); }
});

test("inspection setup rejects stale runs and repository movement during verification", async () => {
  const f = fixture(); await assert.rejects(f.execute({ now: () => "2026-11-13T12:02:00Z" }), /recent/);
  let reads = 0; f.api.branchSha = async () => ++reads === 1 ? A : C;
  await assert.rejects(f.execute(), /changed while verifying/);
});

test("inspection archive parsing permits only one bounded regular report and does not widen worker artifacts", () => {
  const f = fixture();
  assert.equal(resultFiles(f.archive(), { inspection: true }).size, 1);
  assert.throws(() => resultFiles(f.archive()), /Unexpected/);
  for (const entries of [ [["proposal.json", "{}"]], [["../factory-app-inspection.json", "{}"]],
    [["factory-app-inspection.json", "{}", 0o120777]], [["factory-app-inspection.json", "x".repeat(64 * 1024 + 1)]],
    [["factory-app-inspection.json", "{}"], ["proposal.json", "{}"]],
  ]) assert.throws(() => resultFiles(zip(entries), { inspection: true }));
});
