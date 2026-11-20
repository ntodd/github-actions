import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, loadConfig, withFactoryApp, ConfigError } from "../lib/config.mjs";

test("the design's actual YAML example parses, including block scripts and named signals", () => {
  const design = readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8");
  const config = parseConfig(/```yaml\n([\s\S]*?)```/.exec(design)[1]);
  assert.deepEqual(config.trustedUsers, ["ntodd"]);
  assert.equal(config.runner, "crew-l");
  assert.equal(config.setup, "docker compose up -d postgres\n");
  assert.deepEqual(config.signals, [{ check: "dependency-review", blocking: false }]);
  assert.equal(config.timeouts.workerMinutes, 120);
  assert.equal(config.budget.repeatedFailureLimit, 2);
  assert.throws(() => { config.trustedUsers.push("intruder"); }, TypeError);
});

test("YAML ambiguity, aliases, tags and unsupported fields fail closed", () => {
  for (const text of [
    "trusted-users: [ntodd]\ntrusted-users: [other]", "trusted-users: &x [ntodd]\nreview-bots: *x",
    "trusted-users: !!set {ntodd}", "%YAML 1.1\n---\ntrusted-users: [ntodd]", "trusted-users: [ntodd]\n---\nrunner: other",
    "trusted-users: [ntodd]\ntrusted-user: [other]", "trusted-users: []", "trusted-users: ntodd",
    "trusted-users: [ntodd, NTODD]", "trusted-users: [ntodd]\nmax-rounds: .inf",
    "trusted-users: [ntodd]\ntimeouts: {worker-minutes: 0}", "trusted-users: [ntodd]\nrunner: '${{ secrets.KEY }}'",
    "trusted-users: [ntodd]\nsignals: [{check: CI, blocking: 'false'}]",
    "trusted-users: [ntodd]\nbudget: {runs-per-day: 3}", "__proto__: {}\ntrusted-users: [ntodd]",
  ]) assert.throws(() => parseConfig(text), ConfigError, text);
});

test("config loading pins content to the default branch commit rather than event or PR refs", async () => {
  const calls = [];
  const sha = "a".repeat(40);
  const api = { repository: async () => ({ id: 42, default_branch: "trunk" }),
    branchSha: async (branch) => { calls.push(branch); return sha; },
    fileAt: async (path, ref) => { calls.push([path, ref]); return { content: "trusted-users: [ntodd]" }; } };
  const result = await loadConfig(api);
  assert.deepEqual(calls, ["trunk", [".github/factory.yml", sha]]);
  assert.equal(result.repositoryId, "42");
  assert.equal(result.sha, sha);
  assert.equal(result.defaultBranch, "trunk");
});

test("the factory identity comes from the trusted reader and cannot be supplied by repository YAML", async () => {
  const api = { factoryAppLogin: "actual-factory[bot]", repository: async () => ({ id: 42, default_branch: "main" }),
    branchSha: async () => "a".repeat(40), fileAt: async () => ({ content: "trusted-users: [ntodd]\nhandle: unrelated-handle" }) };
  const { config } = await loadConfig(api);
  assert.equal(config.factoryAppLogin, "actual-factory[bot]");
  assert.equal(config.handle, "unrelated-handle");
  assert.throws(() => parseConfig("trusted-users: [ntodd]\nfactoryAppLogin: other[bot]"), ConfigError);
  assert.throws(() => withFactoryApp(config, "other[bot]"), ConfigError);
  assert.throws(() => withFactoryApp(config, "ntodd"), ConfigError);
});
