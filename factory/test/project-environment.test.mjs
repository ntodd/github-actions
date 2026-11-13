import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, symlinkSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseConfig, ConfigError } from "../lib/config.mjs";
import { parseDocument } from "../vendor/yaml.mjs";
import { parseProjectSecrets, selectProjectSecrets, projectValues, projectEnvironmentPath, writeProjectEnvironment,
  readProjectEnvironment, projectProcessEnvironment, ProjectEnvironmentError } from "../lib/project-environment.mjs";
import { runProjectSetup, preparationOutcome } from "../lib/project-setup.mjs";
import { workerEnvironment } from "../lib/worker.mjs";
import { claudeRunner } from "../../agent-ready/lib/claude.mjs";
import { readProposal } from "../lib/artifact.mjs";
import { claimed, operation, run, A } from "./fixtures.mjs";

const configText = `trusted-users: [ntodd]
environment:
  values: {MIX_ENV: test, NODE_ENV: test}
  setup-secrets: [PACKAGE_READ_TOKEN]
  worker-secrets: [DATABASE_PASSWORD]
`;
const config = parseConfig(configText);
const bundle = "PACKAGE_READ_TOKEN=package-private\nDATABASE_PASSWORD=db-private\nUNSELECTED_PASSWORD=not-selected\n";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-project-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assignment = { operation: operation(claimed()), config }, path = join(root, "private", "environment.json");
  const args = { path, assignment, run, text: bundle, mask() {} };
  return { root, path, assignment, args };
}

test("environment configuration is strict, frozen, literal and defaults to no project credentials", () => {
  assert.deepEqual(parseConfig("trusted-users: [ntodd]").environment, { values: {}, setupSecrets: [], workerSecrets: [] });
  assert.equal(config.environment.values.NODE_ENV, "test");
  assert.throws(() => { config.environment.workerSecrets.push("OTHER"); }, TypeError);
  const literal = parseConfig("trusted-users: [ntodd]\nenvironment:\n  values:\n    VALUE: '${{ secrets.KEY }} $(echo x)'\n");
  assert.equal(literal.environment.values.VALUE, "${{ secrets.KEY }} $(echo x)");
  for (const environment of [
    "{values: {PORT: 5432}}", "{values: {FLAG: true}}", "{values: [A]}", "{secrets: [A]}",
    "{worker-secrets: A}", "{worker-secrets: [A, A]}", "{values: {A: x}, setup-secrets: [A]}",
    "{values: {GH_TOKEN: x}}", "{worker-secrets: [AGENT_APP_PRIVATE_KEY]}", "{values: {PATH: x}}",
    "{values: {NODE_OPTIONS: x}}", "{worker-secrets: [ACTIONS_RUNTIME_TOKEN]}", "{setup-secrets: [BASH_ENV]}",
    "{values: {__proto__: x}}", "{worker-secrets: [OPENAI_API_KEY]}",
  ]) assert.throws(() => parseConfig(`trusted-users: [ntodd]\nenvironment: ${environment}`), ConfigError);
});

test("secret formats preserve literal values, multiline JSON and empty values without evaluating shell syntax", () => {
  const value = "literal=$(touch owned) `echo secret` %0A=☃";
  assert.deepEqual(parseProjectSecrets(`A=${value}\r\nB=\r\n`), { A: value, B: "" });
  assert.deepEqual(parseProjectSecrets(JSON.stringify({ A: "line1\nline2\r%", B: "" })), { A: "line1\nline2\r%", B: "" });
  assert.deepEqual(parseProjectSecrets(""), {});
  for (const bad of ["A=private\nA=other", '{"A":"private","A":"other"}', '{"A":"private","\\u0041":"other"}',
    "not-a-key-private", '{"A":42}', '{"A":{"private":"value"}}', "GH_TOKEN=private", "A=private\0", "A=" + "private".repeat(9000)]) {
    assert.throws(() => parseProjectSecrets(bad), (error) => error instanceof ProjectEnvironmentError && !error.message.includes("private"));
  }
  assert.throws(() => selectProjectSecrets(config.environment, "PACKAGE_READ_TOKEN=private"), /DATABASE_PASSWORD/);
});

test("mask registration escapes multiline data without injecting another workflow command", () => {
  const module = new URL("../lib/project-environment.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { maskProjectSecret } from ${JSON.stringify(module)}; maskProjectSecret(process.env.MASK_TEST_VALUE);`],
    { env: { MASK_TEST_VALUE: "value%0A\n::error::not-a-command\r" }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "::add-mask::value%250A%0A::error::not-a-command%0D\n");
  assert.equal(result.stdout.split("\n").length, 2);
});

test("selection stores only declared secrets outside the checkout, with private permissions and owner binding", (t) => {
  const f = fixture(t), masks = [];
  writeProjectEnvironment({ ...f.args, mask: (value) => masks.push(value) });
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const content = readFileSync(f.path, "utf8");
  assert.doesNotMatch(content, /not-selected|UNSELECTED_PASSWORD/);
  assert.deepEqual(masks, ["package-private", "db-private"]);
  assert.deepEqual(readProjectEnvironment(f.args), { PACKAGE_READ_TOKEN: "package-private", DATABASE_PASSWORD: "db-private" });
  const metadata = JSON.parse(content);
  assert.equal(metadata.configSha, A);
  assert.deepEqual(metadata.run, run);
  assert.throws(() => writeProjectEnvironment(f.args), /exist/);
  assert.equal(projectEnvironmentPath({ RUNNER_TEMP: join(f.root, "temp"), GITHUB_WORKSPACE: join(f.root, "project") }),
    join(f.root, "temp", "factory", "project-environment.json"));
  assert.throws(() => projectEnvironmentPath({ RUNNER_TEMP: f.root, GITHUB_WORKSPACE: f.root }), /outside/);
});

test("foreign, exposed, symlinked, changed and oversized secret files cannot supply the worker environment", (t) => {
  const f = fixture(t); writeProjectEnvironment(f.args);
  const original = readFileSync(f.path, "utf8");
  assert.throws(() => readProjectEnvironment({ ...f.args, run: { ...run, attempt: 2 } }), /another operation/);
  for (const patch of [{ operation: "op-other" }, { generation: 2 }, { configSha: "b".repeat(40) },
    { secrets: { GH_TOKEN: "private" } }, { secrets: { DATABASE_PASSWORD: "private" } },
    { secrets: { PACKAGE_READ_TOKEN: "private", DATABASE_PASSWORD: "private", EXTRA: "private" } }]) {
    writeFileSync(f.path, JSON.stringify({ ...JSON.parse(original), ...patch }));
    assert.throws(() => readProjectEnvironment(f.args), (error) => !error.message.includes("private"));
  }
  writeFileSync(f.path, original); chmodSync(f.path, 0o644);
  assert.throws(() => readProjectEnvironment(f.args), /invalid/);
  chmodSync(f.path, 0o600); writeFileSync(f.path, "x".repeat(512 * 1024 + 1));
  assert.throws(() => readProjectEnvironment(f.args), /invalid/);
  unlinkSync(f.path); symlinkSync(join(f.root, "elsewhere"), f.path);
  assert.throws(() => readProjectEnvironment(f.args), /invalid/);
});

test("setup and model processes get their declared values and read token, never ambient credentials or the raw bundle", () => {
  const secrets = selectProjectSecrets(config.environment, bundle);
  const parent = { PATH: process.env.PATH, HOME: "/tmp/home", GH_TOKEN: "write-token", GITHUB_TOKEN: "job-token",
    AGENT_APP_PRIVATE_KEY: "app-key", AGENT_ATTACH_TOKEN: "attachment", ACTIONS_RUNTIME_TOKEN: "runtime",
    FACTORY_PROJECT_SECRETS: bundle, SETUP_SECRETS: bundle, DATABASE_PASSWORD: "ambient-value",
    CLAUDE_CODE_OAUTH_TOKEN: "model", OPENAI_API_KEY: "review-model", NODE_OPTIONS: "--require untrusted",
    GITHUB_ENV: "/tmp/env", GITHUB_PATH: "/tmp/path", CI: "true" };
  const setup = projectProcessEnvironment(parent, "read-only", projectValues(config.environment, secrets, "setup"), "setup");
  const worker = workerEnvironment(parent, "read-only", projectValues(config.environment, secrets, "worker"));
  assert.equal(setup.PACKAGE_READ_TOKEN, "package-private"); assert.equal(setup.DATABASE_PASSWORD, undefined);
  assert.equal(setup.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(setup.GITHUB_ENV, "/tmp/env");
  assert.equal(worker.DATABASE_PASSWORD, "db-private"); assert.equal(worker.PACKAGE_READ_TOKEN, undefined);
  assert.equal(worker.CLAUDE_CODE_OAUTH_TOKEN, "model"); assert.equal(worker.GITHUB_ENV, undefined);
  for (const env of [setup, worker]) {
    assert.equal(env.GH_TOKEN, "read-only"); assert.equal(env.MIX_ENV, "test");
    for (const name of ["GITHUB_TOKEN", "AGENT_APP_PRIVATE_KEY", "AGENT_ATTACH_TOKEN", "ACTIONS_RUNTIME_TOKEN", "FACTORY_PROJECT_SECRETS", "SETUP_SECRETS", "NODE_OPTIONS"]) assert.equal(env[name], undefined, name);
  }
  assert.throws(() => workerEnvironment(parent, "read-only", { GH_TOKEN: "override" }), /reserved/);
});

test("the real setup shell gets selected values literally and stops on the first failing command", async (t) => {
  const f = fixture(t), out = join(f.root, "out"), value = "$(touch owned) `echo data`";
  const setup = parseConfig(`trusted-users: [ntodd]\nenvironment:\n  values: ${JSON.stringify({ OUTPUT_PATH: out, VALUE: value })}\n  setup-secrets: [PACKAGE_READ_TOKEN]\n  worker-secrets: [DATABASE_PASSWORD]\nsetup: |\n  printf '%s|%s|%s|%s|%s' "$VALUE" "$PACKAGE_READ_TOKEN" "\${DATABASE_PASSWORD-unset}" "\${GITHUB_TOKEN-unset}" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" > "$OUTPUT_PATH"\n`);
  const secrets = selectProjectSecrets(setup.environment, bundle);
  const result = await runProjectSetup({ config: setup, secrets, cwd: f.root, readToken: "read-only",
    env: { PATH: process.env.PATH, HOME: f.root, GITHUB_TOKEN: "job", CLAUDE_CODE_OAUTH_TOKEN: "model" } });
  assert.equal(result.status, "ready");
  assert.equal(readFileSync(out, "utf8"), `${value}|package-private|unset|unset|unset`);
  assert.equal(existsSync(join(f.root, "owned")), false);
  const failed = await runProjectSetup({ config: { ...setup, setup: "false\nprintf wrong > failed" }, secrets, cwd: f.root, readToken: "read-only", env: {} });
  assert.equal(failed.status, "failed"); assert.equal(existsSync(join(f.root, "failed")), false);
});

test("the actual Claude runner inherits declared test credentials while setup credentials stay out of its environment", async (t) => {
  const f = fixture(t), capture = join(f.root, "captured.json"), bin = join(f.root, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.ENV_CAPTURE, JSON.stringify(process.env));\nfs.writeFileSync(process.env.AGENT_STATE + '/outcome.json', JSON.stringify({status:'no-change'}));\nconsole.log(JSON.stringify({type:'result',num_turns:1,total_cost_usd:0.01}));\n`, { mode: 0o700 });
  const secrets = selectProjectSecrets(config.environment, bundle);
  const environment = workerEnvironment({ PATH: process.env.PATH, HOME: f.root, GITHUB_TOKEN: "private-job", AGENT_APP_PRIVATE_KEY: "private-app" }, "read-only",
    { ...projectValues(config.environment, secrets, "worker"), ENV_CAPTURE: capture });
  const execute = claudeRunner({ bin, cwd: f.root, stateDir: join(f.root, "state"), sessionId: "test", model: "opus", effort: "medium", maxTurns: 1,
    env: environment, timeoutMs: 5000, log() {} });
  await execute({ phase: "work", token: "read-only", prompt: "test" });
  const child = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(child.DATABASE_PASSWORD, "db-private"); assert.equal(child.MIX_ENV, "test");
  assert.equal(child.PACKAGE_READ_TOKEN, undefined); assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.AGENT_APP_PRIVATE_KEY, undefined); assert.equal(child.GH_TOKEN, "read-only");
});

test("setup deadlines terminate their process group and preparation failures have normal zero-model artifacts", async (t) => {
  const f = fixture(t); let pid;
  const result = await runProjectSetup({ config: { ...config, setup: "while :; do sleep 10; done" },
    secrets: selectProjectSecrets(config.environment, bundle), cwd: f.root, readToken: "read-only", env: { PATH: process.env.PATH }, timeoutMs: 50,
    spawn: (...args) => { const child = spawn(...args); pid = child.pid; return child; } });
  assert.equal(result.status, "failed"); assert.match(result.reason, /deadline/);
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
  const resultDir = join(f.root, "result");
  preparationOutcome({ assignment: f.assignment, run, resultDir, outcome: "needs-you", reason: "Required project secret is missing: DATABASE_PASSWORD" });
  const accepted = readProposal(resultDir, { operation: f.assignment.operation, run }).proposal;
  assert.equal(accepted.outcome, "needs-you"); assert.deepEqual(accepted.effects, []);
  assert.equal(accepted.metrics.cost, 0); assert.equal(accepted.metrics.complete, true);
  assert.doesNotMatch(JSON.stringify(accepted), /db-private|package-private|not-selected/);
});

test("the workflow selects secrets before project checkout, keeps them out of clean jobs and always removes the private file", () => {
  const workflow = parseDocument(readFileSync(new URL("../../.github/workflows/factory-runtime.yml", import.meta.url), "utf8")).toJS();
  const steps = workflow.jobs.worker.steps;
  const secretSteps = steps.filter((s) => JSON.stringify(s).includes("secrets.SETUP_SECRETS"));
  assert.equal(secretSteps.length, 1); assert.match(secretSteps[0].run, /worker\/check.mjs/);
  const checkout = steps.findIndex((s) => s.with?.ref === "${{ needs.control.outputs.head }}");
  assert.ok(steps.indexOf(secretSteps[0]) < checkout);
  for (const job of [workflow.jobs.control, workflow.jobs.update]) assert.equal(JSON.stringify(job).includes("SETUP_SECRETS"), false);
  const cleanup = steps.find((s) => s.name === "Remove selected project secrets");
  assert.equal(cleanup.if, "always()"); assert.match(cleanup.run, /RUNNER_TEMP/);
  const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.doesNotMatch(upload.with.path, /environment|secret|\*/);
  assert.equal(workflow.jobs.control.outputs.setup, undefined);
});
