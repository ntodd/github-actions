import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the actual bootstrap preview CLI needs no local App key and performs no state, secret or repository writes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-bootstrap-cli-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$1" in\n  auth) printf "private-administrator-token\\n" ;;\n  api) printf "ntodd\\n" ;;\n  *) exit 99 ;;\nesac\n', { mode: 0o700 });
  const shim = join(root, "fetch.mjs");
  writeFileSync(shim, `
const A = "a".repeat(40), B = "b".repeat(40);
const file = (content) => ({type:"file",encoding:"base64",size:Buffer.byteLength(content),content:Buffer.from(content).toString("base64")});
globalThis.fetch = async (url, options = {}) => {
  if ((options.method ?? "GET") !== "GET") throw new Error("Bootstrap preview attempted a mutation");
  const path = new URL(url).pathname; let data;
  if (path === "/repos/ntodd/project") data = {id:42,full_name:"ntodd/project",default_branch:"main",permissions:{admin:true}};
  else if (path.endsWith("/git/ref/heads/main")) data = {object:{sha:A}};
  else if (path.endsWith("/actions/variables/AGENT_APP_ID")) data = {name:"AGENT_APP_ID",value:"123"};
  else if (path.endsWith("/actions/secrets")) data = {secrets:[{name:"AGENT_APP_PRIVATE_KEY"}]};
  else if (path.endsWith("/actions/workflows")) data = {workflows:[{name:"CI",state:"active",path:".github/workflows/ci.yml"}]};
  else if (path.endsWith("/contents/.github/workflows/ci.yml")) data = file("name: CI\\non: [push, pull_request]\\n");
  else if (path === "/repos/ntodd/github-actions/commits/" + B) data = {sha:B};
  else if (/^\\/repos\\/ntodd\\/github-actions\\/contents\\/\\.github\\/workflows\\/factory-(runtime|wakeup)\\.yml$/.test(path)) data = file("on:\\n  workflow_call:\\n");
  else if (path.endsWith("/contents/.github/factory.yml") || path.endsWith("/contents/.github/workflows/factory.yml")) return new Response("{}", {status:404});
  else throw new Error("Unexpected bootstrap read: " + path);
  return Response.json(data);
};`);
  const journal = join(root, "journal.json"), ref = "b".repeat(40);
  const result = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../setup/index.mjs", import.meta.url)),
    "--bootstrap", "--preview", "--ref", ref, "--journal", journal, "ntodd/project"], {
    encoding: "utf8", timeout: 10000, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "no-credentials"),
      AGENT_APP_PRIVATE_KEY: "unused-private-key", CLAUDE_CODE_OAUTH_TOKEN: "unused-model-credential" },
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.plan.mode, "bootstrap-read-only"); assert.equal(data.plan.toolingSha, ref); assert.equal(data.plan.files.length, 2);
  assert.equal(data.plan.appIdCandidate, "123"); assert.match(data.plan.files[0].content, /dry-run: true/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-administrator-token|unused-private-key|unused-model-credential/);
  assert.equal(existsSync(journal), false); assert.equal(existsSync(`${journal}.lock`), false);
  assert.equal(existsSync(join(root, "no-credentials")), false);
});
