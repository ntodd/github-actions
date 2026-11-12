import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { callerWorkflow } from "../lib/caller.mjs";
import { zip } from "./archive-fixture.mjs";
import { createHash } from "node:crypto";

test("the actual preview CLI validates credentials/CI/shared refs and makes no mutations or journal writes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-cli-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const appDir = join(dir, "app"), bin = join(dir, "bin"); mkdirSync(appDir); mkdirSync(bin);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(join(appDir, "app.json"), JSON.stringify({ id: 123 }));
  writeFileSync(join(appDir, "private-key.pem"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$1" in\n  auth) printf "test-administrator-token\\n" ;;\n  api) printf "ntodd\\n" ;;\n  *) exit 99 ;;\nesac\n', { mode: 0o700 });
  const shim = join(dir, "fetch.mjs");
  writeFileSync(shim, `
const A = "a".repeat(40), B = "b".repeat(40);
const permissions = {contents:"write",issues:"write",pull_requests:"write",actions:"write",checks:"read",statuses:"read"};
const file = (content) => ({type:"file",encoding:"base64",size:Buffer.byteLength(content),content:Buffer.from(content).toString("base64")});
globalThis.fetch = async (input, options = {}) => {
  if ((options.method ?? "GET") !== "GET") throw new Error("Preview attempted a repository mutation");
  const u = new URL(input), p = u.pathname;
  let value;
  if (p === "/app") value = {id:123,slug:"factory-app",permissions};
  else if (p.endsWith("/installation")) value = {id:7,app_id:123,permissions,repository_selection:"selected",suspended_at:null};
  else if (p === "/repos/ntodd/project") value = {id:42,full_name:"ntodd/project",default_branch:"main",permissions:{admin:true}};
  else if (p.endsWith("/git/ref/heads/main")) value = {object:{sha:A}};
  else if (p.endsWith("/actions/workflows")) value = {workflows:[{name:"CI",path:".github/workflows/ci.yml",state:"active"}]};
  else if (p.endsWith("/contents/.github/workflows/ci.yml")) value = file("name: CI\\non: [push, pull_request]\\n");
  else if (p.endsWith("/check-runs")) value = {check_runs:[{name:"test",app:{id:15368}}]};
  else if (p.endsWith("/statuses")) value = [];
  else if (p === "/repos/ntodd/github-actions/commits/main") value = {sha:B};
  else if (/^\\/repos\\/ntodd\\/github-actions\\/contents\\/\\.github\\/workflows\\/factory-(runtime|wakeup)\\.yml$/.test(p)) value = file("on:\\n  workflow_call:\\n");
  else if (p.endsWith("/actions/secrets")) value = {secrets:[{name:"AGENT_APP_PRIVATE_KEY"},{name:"CLAUDE_CODE_OAUTH_TOKEN"}]};
  else if (p.endsWith("/contents/.github/factory.yml") || p.endsWith("/git/ref/heads/factory-state")) return new Response("{}",{status:404});
  else throw new Error("Unexpected setup read: " + p);
  return new Response(JSON.stringify(value));
};
`);
  const journal = join(dir, "journal.json");
  const result = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../setup/index.mjs", import.meta.url)),
    "--preview", "--app-dir", appDir, "--ci", "CI", "--check", "test@15368", "--journal", journal, "ntodd/project"],
  { encoding: "utf8", timeout: 10_000, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "preview"); assert.equal(output.plan.mode, "read-only");
  assert.equal(output.state, "initialize"); assert.equal(output.plan.files.length, 2);
  assert.equal(output.plan.files[0].content.includes("AGENT_ATTACH_TOKEN"), false);
  assert.equal(result.stdout.includes("test-administrator-token"), false);
  assert.equal(result.stdout.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(existsSync(journal), false); assert.equal(existsSync(`${journal}.lock`), false);
});

test("the actual setup CLI previews from verified inspection metadata with no local App key", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-inspection-cli-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\n[ "$1" = auth ] || exit 99\nprintf "test-administrator-token\\n"\n', { mode: 0o700 });
  const A = "a".repeat(40), B = "b".repeat(40), stamp = (offset) => new Date(Date.now() + offset).toISOString();
  const permissions = { contents: "write", issues: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read" };
  const report = { schemaVersion: 1, observedAt: stamp(-60000), actor: "ntodd", repository: { id: "42", fullName: "ntodd/project", defaultBranch: "main", headSha: A },
    run: { id: "100", attempt: 1 }, tooling: { repository: "ntodd/github-actions", sha: B }, app: { id: 123, slug: "factory-app", permissions },
    installation: { id: 7, app_id: 123, permissions, suspended_at: null, repository_selection: "selected" } };
  const archive = zip([["factory-app-inspection.json", JSON.stringify(report)]]), digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const shim = join(dir, "fetch.mjs"), journal = join(dir, "journal.json");
  writeFileSync(shim, `
const A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)}, digest = ${JSON.stringify(digest)};
const archive = Buffer.from(${JSON.stringify(archive.toString("base64"))}, "base64");
const caller = ${JSON.stringify(callerWorkflow({ defaultBranch: "main", ciWorkflows: ["CI"], ref: B }))};
const file = (content) => ({type:"file",encoding:"base64",size:Buffer.byteLength(content),content:Buffer.from(content).toString("base64")});
globalThis.fetch = async (input, options = {}) => {
  if ((options.method ?? "GET") !== "GET") throw new Error("Preview attempted a mutation");
  const u = new URL(input), p = u.pathname; let value;
  if (u.origin === "https://objects.example") {
    if (options.headers) throw new Error("Signed download received administrator credentials");
    if (process.env.FACTORY_TEST_TAMPER === "1") archive[0] ^= 1;
    return new Response(archive);
  }
  if (p === "/repos/ntodd/project") value = {id:42,full_name:"ntodd/project",default_branch:"main",permissions:{admin:true},owner:{login:"ntodd",type:"User"}};
  else if (p.endsWith("/git/ref/heads/main")) value = {object:{sha:A}};
  else if (p.endsWith("/contents/.github/workflows/factory.yml")) value = file(caller);
  else if (p.endsWith("/contents/.github/factory.yml")) value = file("trusted-users: [ntodd]\\n");
  else if (p.endsWith("/actions/runs/100/attempts/1")) value = {id:100,run_attempt:1,repository:{id:42},head_repository:{id:42},
    path:".github/workflows/factory.yml",head_sha:A,head_branch:"main",event:"workflow_dispatch",status:"completed",conclusion:"success",
    actor:{login:"ntodd"},triggering_actor:{login:"ntodd"},run_started_at:${JSON.stringify(stamp(-180000))},updated_at:${JSON.stringify(stamp(-30000))},
    referenced_workflows:[{path:"ntodd/github-actions/.github/workflows/factory-runtime.yml@"+B,sha:B}]};
  else if (p.endsWith("/attempts/1/jobs")) value = {jobs:[{name:"factory / factory-control",run_id:100,run_attempt:1,head_sha:A,status:"completed",conclusion:"success",
    steps:[{name:"Upload public App inspection metadata",status:"completed",conclusion:"success"}]}]};
  else if (p.endsWith("/runs/100/artifacts")) value = {artifacts:[{id:300,name:"factory-inspection-100-1",expired:false,digest,size_in_bytes:archive.length,
    created_at:${JSON.stringify(report.observedAt)},expires_at:${JSON.stringify(stamp(86400000))},workflow_run:{id:100,repository_id:42,head_repository_id:42,head_sha:A,head_branch:"main"}}]};
  else if (p.endsWith("/artifacts/300/zip")) return new Response(null,{status:302,headers:{location:"https://objects.example/report?signature=opaque"}});
  else if (p.endsWith("/actions/variables/AGENT_APP_ID")) value = {value:"123"};
  else if (p.endsWith("/actions/secrets")) value = {secrets:[{name:"AGENT_APP_PRIVATE_KEY"},{name:"CLAUDE_CODE_OAUTH_TOKEN"}]};
  else if (p.endsWith("/actions/workflows")) value = {workflows:[{name:"CI",path:".github/workflows/ci.yml",state:"active"}]};
  else if (p.endsWith("/contents/.github/workflows/ci.yml")) value = file("name: CI\\non: [push, pull_request]\\n");
  else if (p.endsWith("/check-runs")) value = {check_runs:[{name:"test",app:{id:15368}}]};
  else if (p.endsWith("/statuses")) value = [];
  else if (p === "/repos/ntodd/github-actions/commits/"+B) value = {sha:B};
  else if (/^\\/repos\\/ntodd\\/github-actions\\/contents\\/\\.github\\/workflows\\/factory-(runtime|wakeup)\\.yml$/.test(p)) value = file("on:\\n  workflow_call:\\n    secrets:\\n      AGENT_ATTACH_TOKEN: {required: false}\\n");
  else if (p.endsWith("/git/ref/heads/factory-state")) return new Response("{}",{status:404});
  else throw new Error("Unexpected inspection setup read: "+p);
  return Response.json(value);
};
`);
  const result = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../setup/index.mjs", import.meta.url)),
    "--inspection-run", "100", "--ref", B, "--preview", "--check", "test@15368", "--journal", journal, "ntodd/project"],
  { encoding: "utf8", timeout: 10000, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "preview"); assert.equal(output.plan.appId, 123);
  assert.equal(output.plan.appInspection.artifact.digest, digest); assert.equal(output.plan.appInspection.run.id, "100");
  assert.equal(output.plan.files[0].content.includes("AGENT_ATTACH_TOKEN: \${{ secrets.AGENT_ATTACH_TOKEN }}"), true);
  assert.equal(result.stdout.includes("test-administrator-token"), false);
  assert.deepEqual(output.secrets, []);
  assert.equal(existsSync(journal), false); assert.equal(existsSync(`${journal}.lock`), false);
  const invalid = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../setup/index.mjs", import.meta.url)),
    "--inspection-run", "100", "--ref", B, "--check", "test@15368", "--journal", journal, "ntodd/project"],
  { encoding: "utf8", timeout: 10000, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FACTORY_TEST_TAMPER: "1" } });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /digest does not match/);
  assert.equal(invalid.stdout, ""); assert.equal(existsSync(journal), false); assert.equal(existsSync(`${journal}.lock`), false);
});
