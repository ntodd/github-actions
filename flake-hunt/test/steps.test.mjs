// The triage and report steps, end to end over temp directories and a fake
// GitHub client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriage } from "../lib/triage.mjs";
import { runReport } from "../lib/report.mjs";
import { markerFor } from "../lib/issues.mjs";
import { renderPrompt } from "../lib/prompt.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "flake-hunt-"));

function writeResults(dir, shard, lines) {
  mkdirSync(join(dir, `shard-${shard}`), { recursive: true });
  writeFileSync(join(dir, `shard-${shard}`, "results.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const t = (name, run, status, over = {}) => ({
  type: "test",
  module: "Demo.Test",
  name,
  file: "test/demo_test.exs",
  line: 3,
  status,
  seed: 1000 + run,
  run,
  shard: 1,
  ...(status === "failed" ? { message: `failed in run ${run}` } : {}),
  ...over,
});

const r = (run, tests) => ({ type: "run", shard: 1, run, exit: 0, tests });

function fixture() {
  const results = tmp();
  writeResults(results, 1, [
    t("test stable", 1, "passed"),
    t("test flaky", 1, "passed"),
    t("test broken", 1, "failed"),
    r(1, 3),
    t("test stable", 2, "passed"),
    t("test flaky", 2, "failed"),
    t("test broken", 2, "failed"),
    r(2, 3),
  ]);
  return results;
}

class FakeGitHub {
  constructor(issues = []) {
    this.issues = issues;
    this.calls = [];
    this.next = 50;
  }
  async listIssues(label) {
    this.calls.push(["list", label]);
    return this.issues;
  }
  async ensureLabel(name) {
    this.calls.push(["label", name]);
  }
  async createIssue(issue) {
    this.calls.push(["create", issue]);
    return { number: this.next++ };
  }
  async comment(number, body) {
    this.calls.push(["comment", number, body]);
  }
  async reopen(number) {
    this.calls.push(["reopen", number]);
  }
  async defaultBranch() {
    return "main";
  }
}

const ctx = {
  repo: "ntodd/demo",
  sha: "abcdef0123456789abcdef0123456789abcdef01",
  serverUrl: "https://github.com",
  runUrl: "https://github.com/ntodd/demo/actions/runs/1",
};

test("renderPrompt fills in the flake's details", () => {
  const out = renderPrompt(
    "Test {{test}} in {{file}}:{{line}} failed {{failures}}/{{runs}}. Seeds {{seeds}}. Dir {{working_directory}}.\n{{failures_block}}",
    {
      key: "k",
      module: "Demo.Test",
      name: "test flaky",
      file: "test/demo_test.exs",
      line: 3,
      runs: 2,
      failures: 1,
      failedRuns: [{ seed: 1002, shard: 1, run: 2, message: "boom" }],
    },
    { workingDirectory: "apps/demo" },
  );
  assert.match(out, /Test Demo.Test "flaky" in test\/demo_test.exs:3 failed 1\/2\. Seeds 1002\. Dir apps\/demo\./);
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /\{\{/);
});

test("triage finds the flaky and broken tests, plans issues and writes prompts", async () => {
  const results = fixture();
  const out = tmp();
  const gh = new FakeGitHub();

  const summary = await runTriage({
    resultsDir: results,
    outDir: out,
    workingDirectory: ".",
    label: "flaky-test",
    maxDiagnoses: 3,
    canDiagnose: true,
    gh,
    template: "Diagnose {{test}}",
  });

  assert.deepEqual(summary, { flakyCount: 1, brokenCount: 1, diagnoseCount: 1 });
  const triage = JSON.parse(readFileSync(join(out, "triage.json"), "utf8"));
  assert.equal(triage.testCount, 3);
  assert.deepEqual(triage.runs, { total: 2, reported: 2, errored: 0 });
  assert.equal(triage.plan.length, 1);
  assert.equal(triage.plan[0].flake.name, "test flaky");
  assert.equal(triage.plan[0].action, "create");
  assert.equal(triage.plan[0].diagnose, "d1");
  assert.equal(triage.broken[0].name, "test broken");
  assert.deepEqual(readdirSync(join(out, "prompts")), ["d1.md"]);
  assert.equal(readFileSync(join(out, "prompts", "d1.md"), "utf8"), 'Diagnose Demo.Test "flaky"');
});

test("triage diagnoses only new or reopened flakes, up to the limit, and only with a token", async () => {
  const results = tmp();
  const lines = [];
  for (const run of [1, 2]) {
    for (const n of ["a", "b", "c"]) lines.push(t(`test ${n}`, run, run === 2 ? "failed" : "passed"));
    lines.push(r(run, 3));
  }
  writeResults(results, 1, lines);
  const open = { number: 7, state: "open", body: markerFor("::Demo.Test::test a") };

  const out = tmp();
  const limited = await runTriage({
    resultsDir: results, outDir: out, workingDirectory: ".", label: "flaky-test",
    maxDiagnoses: 1, canDiagnose: true, gh: new FakeGitHub([open]), template: "x",
  });
  assert.deepEqual(limited, { flakyCount: 3, brokenCount: 0, diagnoseCount: 1 });
  const plan = JSON.parse(readFileSync(join(out, "triage.json"), "utf8")).plan;
  assert.deepEqual(plan.map((p) => [p.flake.name, p.action, p.diagnose ?? null]), [
    ["test a", "comment", null],
    ["test b", "create", "d1"],
    ["test c", "create", null],
  ]);

  const out2 = tmp();
  const noToken = await runTriage({
    resultsDir: results, outDir: out2, workingDirectory: ".", label: "flaky-test",
    maxDiagnoses: 3, canDiagnose: false, gh: new FakeGitHub(), template: "x",
  });
  assert.equal(noToken.diagnoseCount, 0);
  assert.match(JSON.parse(readFileSync(join(out2, "triage.json"), "utf8")).diagnosisNote, /no Claude token/);
});

test("triage fails when no run reported any tests", async () => {
  const results = tmp();
  writeResults(results, 1, [r(1, 0), r(2, 0)]);
  await assert.rejects(
    runTriage({ resultsDir: results, outDir: tmp(), workingDirectory: ".", label: "l", maxDiagnoses: 1, canDiagnose: false, gh: new FakeGitHub(), template: "" }),
    /No run reported any tests/,
  );
});

async function triaged(issues = []) {
  const out = tmp();
  await runTriage({
    resultsDir: fixture(), outDir: out, workingDirectory: ".", label: "flaky-test",
    maxDiagnoses: 3, canDiagnose: true, gh: new FakeGitHub(issues), template: "x",
  });
  return out;
}

test("report opens an issue with the diagnosis and writes the summary", async () => {
  const triageDir = await triaged();
  const diagnoses = tmp();
  writeFileSync(join(diagnoses, "d1.md"), "**Likely cause:** order.");
  const summaryFile = join(tmp(), "summary.md");
  const gh = new FakeGitHub();

  await runReport({ triageDir, diagnosesDir: diagnoses, label: "flaky-test", dryRun: false, gh, ctx, summaryFile });

  const create = gh.calls.find((c) => c[0] === "create")[1];
  assert.equal(create.title, 'Flaky test: Demo.Test "flaky"');
  assert.deepEqual(create.labels, ["flaky-test"]);
  assert.match(create.body, /Likely cause:\*\* order/);
  assert.match(create.body, /flake-hunt:/);
  assert.ok(gh.calls.some((c) => c[0] === "label"));
  const summary = readFileSync(summaryFile, "utf8");
  assert.match(summary, /opened #50/);
  assert.match(summary, /Failed every run/);
});

test("report comments on an open issue and reopens a closed one", async () => {
  const issues = [{ number: 3, state: "closed", state_reason: "completed", body: markerFor("::Demo.Test::test flaky"), updated_at: "2026-01-01" }];
  const triageDir = await triaged(issues);
  const gh = new FakeGitHub();

  await runReport({ triageDir, diagnosesDir: join(tmp(), "missing"), label: "flaky-test", dryRun: false, gh, ctx, summaryFile: join(tmp(), "s.md") });

  assert.deepEqual(gh.calls.filter((c) => c[0] !== "label").map((c) => c.slice(0, 2)), [["comment", 3], ["reopen", 3]]);
  assert.match(gh.calls.find((c) => c[0] === "comment")[2], /Flaky again/);
});

test("a dry run touches no issues and puts the bodies in the summary", async () => {
  const triageDir = await triaged();
  const gh = new FakeGitHub();
  const summaryFile = join(tmp(), "s.md");

  await runReport({ triageDir, diagnosesDir: tmp(), label: "flaky-test", dryRun: true, gh, ctx, summaryFile });

  assert.deepEqual(gh.calls, []);
  const summary = readFileSync(summaryFile, "utf8");
  assert.match(summary, /Dry run/);
  assert.match(summary, /would open an issue/);
  assert.match(summary, /<details><summary>Issue: Flaky test: Demo.Test &quot;flaky&quot;<\/summary>/);
});

test("report keeps going after a failed API call, then fails", async () => {
  const results = tmp();
  const lines = [];
  for (const run of [1, 2]) {
    for (const n of ["a", "b"]) lines.push(t(`test ${n}`, run, run === 2 ? "failed" : "passed"));
    lines.push(r(run, 2));
  }
  writeResults(results, 1, lines);
  const triageDir = tmp();
  await runTriage({ resultsDir: results, outDir: triageDir, workingDirectory: ".", label: "l", maxDiagnoses: 0, canDiagnose: false, gh: new FakeGitHub(), template: "" });

  const gh = new FakeGitHub();
  let first = true;
  gh.createIssue = async (issue) => {
    gh.calls.push(["create", issue]);
    if (first) {
      first = false;
      throw new Error("GitHub 502");
    }
    return { number: 60 };
  };
  const summaryFile = join(tmp(), "s.md");

  await assert.rejects(
    runReport({ triageDir, diagnosesDir: tmp(), label: "l", dryRun: false, gh, ctx, summaryFile }),
    /1 of 2 issue updates failed/,
  );
  assert.equal(gh.calls.filter((c) => c[0] === "create").length, 2);
  assert.ok(existsSync(summaryFile));
  assert.match(readFileSync(summaryFile, "utf8"), /failed: GitHub 502/);
});

test("triage fails clearly when no shard uploaded anything", async () => {
  await assert.rejects(
    runTriage({ resultsDir: join(tmp(), "never-downloaded"), outDir: tmp(), workingDirectory: ".", label: "l", maxDiagnoses: 1, canDiagnose: false, gh: new FakeGitHub(), template: "" }),
    /No run reported any tests \(0 runs\)/,
  );
});
