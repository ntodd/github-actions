import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  assert.equal(result.stdout.includes("test-administrator-token"), false);
  assert.equal(result.stdout.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(existsSync(journal), false); assert.equal(existsSync(`${journal}.lock`), false);
});
