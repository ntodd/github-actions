// run/hunt.sh and run/flake_formatter.exs against a real Mix project, and
// run/versions.sh against mise.toml and .tool-versions files. The hunt
// tests need elixir on the PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, classify, parseJsonl } from "../lib/aggregate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hunt = join(here, "..", "run", "hunt.sh");
const versions = join(here, "..", "run", "versions.sh");
const hasElixir = spawnSync("elixir", ["--version"]).status === 0;

function copyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "flake-hunt-fixture-"));
  cpSync(join(here, "fixture"), dir, { recursive: true, filter: (src) => !/\/(_build|deps)(\/|$)/.test(src) });
  return dir;
}

function runHunt(cwd, env) {
  const out = join(mkdtempSync(join(tmpdir(), "flake-hunt-out-")), "shard-2", "results.jsonl");
  const res = spawnSync("bash", [hunt], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MIX_ENV: "test", FLAKE_HUNT_OUT: out, FLAKE_HUNT_SHARD: "2", ...env },
  });
  return { ...res, out };
}

test("hunt.sh runs the suite N times and the formatter records every test", { skip: !hasElixir && "no elixir" }, () => {
  const project = copyFixture();
  try {
    const res = runHunt(project, { FLAKE_HUNT_RUNS: "4" });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const records = parseJsonl(readFileSync(res.out, "utf8"));
    const runs = records.filter((r) => r.type === "run");
    assert.deepEqual(runs.map((r) => [r.shard, r.run]), [[2, 1], [2, 2], [2, 3], [2, 4]]);
    assert.ok(runs.every((r) => r.tests === 5), JSON.stringify(runs));

    const { tests } = aggregate(records, { workingDirectory: "." });
    const byName = Object.fromEntries(tests.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), [
      "test always fails",
      "test behind setup_all",
      "test flaky on even runs",
      "test group nested",
      "test stable",
    ]);

    const flaky = byName["test flaky on even runs"];
    assert.equal(flaky.module, "FixtureTest");
    assert.equal(flaky.file, "test/fixture_test.exs");
    assert.equal(flaky.line, 10);
    assert.equal(flaky.runs, 4);
    assert.equal(flaky.failures, 2);
    assert.deepEqual(flaky.failedRuns.map((r) => r.run), [2, 4]);
    assert.ok(flaky.failedRuns.every((r) => Number.isInteger(r.seed)));
    assert.match(flaky.failedRuns[0].message, /even run 2/);
    assert.doesNotMatch(flaky.failedRuns[0].message, /\x1b\[/);

    assert.equal(byName["test behind setup_all"].failures, 2);
    assert.match(byName["test behind setup_all"].failedRuns[0].message, /setup_all failed on run 2/);

    const { flaky: f, broken } = classify(tests);
    assert.deepEqual(f.map((t) => t.name).sort(), ["test behind setup_all", "test flaky on even runs"]);
    assert.deepEqual(broken.map((t) => t.name), ["test always fails"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("hunt.sh passes extra arguments to mix test", { skip: !hasElixir && "no elixir" }, () => {
  const project = copyFixture();
  try {
    const res = runHunt(project, { FLAKE_HUNT_RUNS: "1", FLAKE_HUNT_TEST_ARGS: "--exclude test --include line:6" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const names = parseJsonl(readFileSync(res.out, "utf8")).filter((r) => r.type === "test").map((r) => r.name);
    assert.deepEqual(names, ["test stable"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("hunt.sh fails when no run reports any tests", { skip: !hasElixir && "no elixir" }, () => {
  const project = copyFixture();
  try {
    writeFileSync(join(project, "test", "broken_test.exs"), "defmodule BrokenTest do\n  this is not elixir\nend\n");
    const res = runHunt(project, { FLAKE_HUNT_RUNS: "2" });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /No run reported any tests/);
    const runs = parseJsonl(readFileSync(res.out, "utf8")).filter((r) => r.type === "run");
    assert.deepEqual(runs.map((r) => r.tests), [0, 0]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

function resolveVersions(files, { project = ".", env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "flake-hunt-versions-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const output = join(root, "github_output");
  writeFileSync(output, "");
  const res = spawnSync("bash", [versions, join(root, project), root], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, FLAKE_HUNT_ELIXIR: "", FLAKE_HUNT_OTP: "", ...env },
  });
  return { ...res, output: readFileSync(output, "utf8") };
}

test("versions.sh reads mise.toml's [tools] and drops elixir's -otp suffix", () => {
  const res = resolveVersions({
    "mise.toml": '[env]\nelixir = "nope"\n\n[tools]\nerlang = "29.1.1"\nelixir = "1.20.4-otp-29" # pinned\nnode = "22"\n',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.output, "elixir=1.20.4\notp=29.1.1\n");
});

test("versions.sh prefers the project's files, then the repo root's, and inputs over both", () => {
  const files = {
    "mise.toml": '[tools]\nerlang = "28.0"\nelixir = "1.18.0"\n',
    "apps/x/.tool-versions": "elixir 1.19.1-otp-28\n",
  };
  assert.equal(resolveVersions(files, { project: "apps/x" }).output, "elixir=1.19.1\notp=28.0\n");
  assert.equal(
    resolveVersions(files, { project: "apps/x", env: { FLAKE_HUNT_OTP: "27.3" } }).output,
    "elixir=1.19.1\notp=27.3\n",
  );
});

test("versions.sh fails with a hint when it can't find a version", () => {
  const res = resolveVersions({ "mise.toml": '[tools]\nnode = "22"\n' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /elixir-version/);
});
