import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectFactoryApp } from "../lib/app-inspection.mjs";
import { controllerWakeup } from "../lib/entry.mjs";
import { parseRequest } from "../lib/controller.mjs";
import { parseConfig } from "../lib/config.mjs";
import { parseDocument } from "../vendor/yaml.mjs";
import { A, B, at } from "./fixtures.mjs";

const permissions = { contents: "write", issues: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read", metadata: "read" };
function fixture() {
  const env = { GITHUB_REPOSITORY: "ntodd/project", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: A,
    GITHUB_WORKFLOW_REF: "ntodd/project/.github/workflows/factory.yml@refs/heads/main", GITHUB_ACTOR: "ntodd", GITHUB_TRIGGERING_ACTOR: "ntodd",
    GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", FACTORY_TOOLING_SHA: B, FACTORY_TOOLING_REPOSITORY: "ntodd/github-actions",
    FACTORY_APP_ID: "123", FACTORY_APP_PRIVATE_KEY: "private-key-that-must-stay-local-to-the-job" };
  const repository = { id: 42, full_name: "ntodd/project", default_branch: "main", owner: { login: "ntodd", type: "User" } };
  const run = { id: 100, run_attempt: 1, path: ".github/workflows/factory.yml", repository: { id: 42 }, head_repository: { id: 42 },
    head_branch: "main", head_sha: A, status: "in_progress", event: "workflow_dispatch", actor: { login: "ntodd" }, triggering_actor: { login: "ntodd" } };
  const metadata = { app: { id: 123, slug: "factory-app", permissions },
    installation: { id: 7, app_id: 123, permissions, repository_selection: "selected", suspended_at: null } };
  const api = { repository: async () => repository, run: async () => run, branchSha: async () => A };
  let calls = 0;
  const inspect = async ({ privateKey, appId, repo }) => {
    calls++; assert.equal(privateKey, env.FACTORY_APP_PRIVATE_KEY); assert.equal(appId, 123); assert.equal(repo, repository.full_name);
    return { ...metadata, token: "unrelated-private-response-field", app: { ...metadata.app, private_key: "private-field" },
      installation: { ...metadata.installation, access_token: "installation-private-field" } };
  };
  const context = { repositoryId: "42", defaultBranch: "main", sha: A, config: parseConfig("trusted-users: [ntodd]") };
  return { env, api, repository, run, metadata, context, inspect, get calls() { return calls; },
    execute: (extra = {}) => inspectFactoryApp({ env, api, context, inspect, now: () => at, ...extra }) };
}

test("App inspection returns selected public metadata after owner, entry, current-head and installation validation", async () => {
  const f = fixture(), report = await f.execute();
  assert.equal(f.calls, 1); assert.equal(report.repository.headSha, A); assert.equal(report.tooling.sha, B);
  assert.equal(report.app.slug, "factory-app"); assert.equal(report.installation.id, 7);
  assert.doesNotMatch(JSON.stringify(report), /private|token|key/);
  assert.deepEqual(report.run, { id: "100", attempt: 1 });
});

test("untrusted events, branches, actors, run attempts and moving default heads cannot inspect an App credential", async () => {
  for (const change of [
    { GITHUB_EVENT_NAME: "issue_comment" }, { GITHUB_ACTOR: "other" }, { GITHUB_TRIGGERING_ACTOR: "other" },
    { GITHUB_REF: "refs/heads/topic" }, { GITHUB_WORKFLOW_REF: "ntodd/project/.github/workflows/factory.yml@refs/heads/topic" },
    { GITHUB_RUN_ATTEMPT: "2" }, { FACTORY_TOOLING_REPOSITORY: "other/tools" }, { FACTORY_TOOLING_SHA: "main" },
  ]) { const f = fixture(); await assert.rejects(f.execute({ env: { ...f.env, ...change } })); assert.equal(f.calls, 0); }
  for (const change of [{ actor: { login: "other" } }, { triggering_actor: { login: "other" } }, { event: "push" }, { status: "completed" }]) {
    const f = fixture(); Object.assign(f.run, change); await assert.rejects(f.execute()); assert.equal(f.calls, 0);
  }
  const f = fixture(); f.api.branchSha = async () => B; await assert.rejects(f.execute(), /current default branch/); assert.equal(f.calls, 0);
});

test("mismatched, suspended, overprivileged and incomplete installations do not produce a setup report", async () => {
  for (const patch of [{ app_id: 999 }, { suspended_at: at }, { repository_selection: "unknown" },
    { permissions: { ...permissions, workflows: "write" } }, { permissions: { ...permissions, actions: "read" } }]) {
    const f = fixture(); await assert.rejects(f.execute({ inspect: async () => ({ ...f.metadata, installation: { ...f.metadata.installation, ...patch } }) }));
  }
  const f = fixture();
  await assert.rejects(f.execute({ inspect: async () => ({ ...f.metadata, app: { ...f.metadata.app, permissions: { ...permissions, administration: "write" } } }) }));
  await assert.rejects(f.execute({ inspect: async () => { throw new Error("private-key-value"); } }), (e) => !e.message.includes("private-key-value"));
});

test("inspection is an exact internal request and controller-completion events do not allocate more controllers", () => {
  assert.deepEqual(parseRequest('{"kind":"inspect"}'), { kind: "inspect" });
  for (const value of [{ kind: "inspect", target: 7 }, { kind: "inspect", item: "issue:7" }, { kind: "inspect", operation: "op-1" }]) assert.throws(() => parseRequest(JSON.stringify(value)));
  assert.equal(controllerWakeup("workflow_run", { workflow_run: { path: ".github/workflows/factory.yml", event: "workflow_dispatch", display_title: "factory worker" } }), true);
  for (const display_title of ["factory reconcile", "factory", undefined]) {
    assert.equal(controllerWakeup("workflow_run", { workflow_run: { path: ".github/workflows/factory.yml", event: "workflow_dispatch", display_title } }), false);
  }
  for (const event of ["workflow_run", "issue_comment", "push", "schedule"]) {
    assert.equal(controllerWakeup("workflow_run", { workflow_run: { path: ".github/workflows/factory.yml", event } }), false);
  }
  assert.equal(controllerWakeup("workflow_run", { workflow_run: { path: ".github/workflows/ci.yml", event: "push" } }), true);
  const shared = parseDocument(readFileSync(new URL("../../.github/workflows/factory-runtime.yml", import.meta.url), "utf8")).toJS();
  assert.equal(shared.jobs.control.if, "github.event_name != 'workflow_run' || github.event.workflow_run.path != '.github/workflows/factory.yml' || (github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.display_title == 'factory worker')");
});

test("the real controller inspection entry performs GETs only, emits no worker, and exports no credential or state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-inspection-entry-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const shim = join(root, "fetch.mjs"), event = join(root, "event.json"), output = join(root, "output"), summary = join(root, "summary");
  writeFileSync(event, "{}");
  writeFileSync(shim, `
const A = "a".repeat(40);
const permissions = ${JSON.stringify(permissions)};
globalThis.fetch = async (url, options = {}) => {
  if ((options.method ?? "GET") !== "GET") throw new Error("Inspection attempted a mutation/token request");
  const path = new URL(url).pathname; let data;
  if (path === "/repos/ntodd/project") data = {id:42,full_name:"ntodd/project",default_branch:"main",owner:{login:"ntodd",type:"User"}};
  else if (path.endsWith("/git/ref/heads/main")) data = {object:{sha:A}};
  else if (path.endsWith("/contents/.github/factory.yml")) {
    const text = "trusted-users: [ntodd]\\n"; data = {type:"file",encoding:"base64",size:Buffer.byteLength(text),content:Buffer.from(text).toString("base64")};
  } else if (path.endsWith("/actions/runs/100/attempts/1")) data = {id:100,run_attempt:1,path:".github/workflows/factory.yml",repository:{id:42},head_repository:{id:42},head_branch:"main",head_sha:A,status:"in_progress",event:"workflow_dispatch",actor:{login:"ntodd"},triggering_actor:{login:"ntodd"}};
  else if (path === "/app") data = {id:123,slug:"factory-app",permissions};
  else if (path === "/repos/ntodd/project/installation") data = {id:7,app_id:123,permissions,repository_selection:"selected",suspended_at:null};
  else if (path.endsWith("/git/ref/heads/factory-state") && process.env.FACTORY_REQUEST !== '{"kind":"inspect"}') return new Response("{}", {status:404});
  else throw new Error("Unexpected inspection read: " + path);
  return Response.json(data);
};`);
  const f = fixture();
  const result = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../control/index.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 10000, env: { ...f.env, GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "private-job-token", GITHUB_EVENT_PATH: event,
      FACTORY_APP_PRIVATE_KEY: pem, FACTORY_REQUEST: '{"kind":"inspect"}', FACTORY_DRY_RUN: "true", RUNNER_TEMP: root,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(join(root, "factory-app-inspection.json"), "utf8"), outputs = readFileSync(output, "utf8");
  assert.equal(JSON.parse(report).app.id, 123); assert.match(outputs, /inspection/); assert.doesNotMatch(outputs, /worker/);
  assert.doesNotMatch([result.stdout, result.stderr, report, readFileSync(summary, "utf8")].join(""), /PRIVATE KEY|private-job-token/);
  assert.equal(existsSync(join(root, "factory-state")), false);
  const initial = join(root, "initial"); mkdirSync(initial);
  const uninitialized = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../control/index.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 10000, env: { ...f.env, GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "private-job-token", GITHUB_EVENT_PATH: event,
      FACTORY_APP_PRIVATE_KEY: "unused-invalid-private-key", FACTORY_REQUEST: "", FACTORY_DRY_RUN: "true", RUNNER_TEMP: initial,
      GITHUB_OUTPUT: join(initial, "output"), GITHUB_STEP_SUMMARY: join(initial, "summary") },
  });
  assert.equal(uninitialized.status, 0, uninitialized.stderr);
  assert.match(readFileSync(join(initial, "summary"), "utf8"), /setup is incomplete/);
  assert.equal(existsSync(join(initial, "output")), false);
  assert.equal(existsSync(join(initial, "factory-app-inspection.json")), false);
});
