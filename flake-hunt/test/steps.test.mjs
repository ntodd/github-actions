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
  async addLabels(number, labels) {
    this.calls.push(["addLabels", number, labels]);
  }
  async setBody(number, body) {
    this.calls.push(["setBody", number, body]);
  }
  async dispatch(workflow, ref, inputs) {
    this.calls.push(["dispatch", workflow, ref, inputs]);
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
  const gh = new FakeGitHub(issues);

  await runReport({ triageDir, diagnosesDir: join(tmp(), "missing"), label: "flaky-test", dryRun: false, gh, ctx, summaryFile: join(tmp(), "s.md") });

  assert.deepEqual(gh.calls.filter((c) => c[0] !== "label" && c[0] !== "list").map((c) => c.slice(0, 2)), [["comment", 3], ["reopen", 3]]);
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

const agent = { workflow: "agent-ready.yml", label: "agent-ready", ref: "main" };

test("with an agent workflow, a new issue gets its label and starts a run on it", async () => {
  const triageDir = await triaged();
  const summaryFile = join(tmp(), "s.md");
  const gh = new FakeGitHub();

  await runReport({ triageDir, diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile, agent });

  assert.deepEqual(gh.calls.find((c) => c[0] === "create")[1].labels, ["flaky-test", "agent-ready"]);
  assert.deepEqual(gh.calls.at(-1), ["dispatch", "agent-ready.yml", "main", { issue: "50" }]);
  assert.match(readFileSync(summaryFile, "utf8"), /opened #50 and started agent-ready\.yml/);
});

test("with an agent workflow, a reopened issue is labeled again and gets a run, and a still-open one doesn't", async () => {
  const key = "::Demo.Test::test flaky";
  const closed = [{ number: 3, state: "closed", state_reason: "completed", body: markerFor(key), updated_at: "2026-01-01" }];
  let gh = new FakeGitHub(closed);
  await runReport({ triageDir: await triaged(closed), diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile: join(tmp(), "s.md"), agent });
  assert.deepEqual(
    gh.calls.filter((c) => c[0] !== "label" && c[0] !== "list").map((c) => c.slice(0, 2)),
    [["addLabels", 3], ["comment", 3], ["reopen", 3], ["dispatch", "agent-ready.yml"]],
  );
  assert.deepEqual(gh.calls.find((c) => c[0] === "addLabels")[2], ["agent-ready"]);

  const open = [{ number: 4, state: "open", body: markerFor(key) }];
  gh = new FakeGitHub(open);
  await runReport({ triageDir: await triaged(open), diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile: join(tmp(), "s.md"), agent });
  assert.deepEqual(gh.calls.map((c) => c[0]), ["list", "comment"]);
});

test("an agent run that won't start fails the report, after the issue is filed", async () => {
  const triageDir = await triaged();
  const summaryFile = join(tmp(), "s.md");
  const gh = new FakeGitHub();
  gh.dispatch = async () => {
    throw new Error("GitHub 422: Workflow does not have 'workflow_dispatch' trigger");
  };

  await assert.rejects(
    runReport({ triageDir, diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile, agent }),
    /1 of 1 issue updates failed/,
  );
  assert.match(readFileSync(summaryFile, "utf8"), /opened #50, but couldn't start agent-ready\.yml: GitHub 422.*gh workflow run agent-ready\.yml -f issue=50/);
});

test("a rerun report acts on the issues as they are now, not as triage saw them", async () => {
  const key = "::Demo.Test::test flaky";
  // Triage saw no issue, and then a report that failed later opened one.
  let gh = new FakeGitHub([{ number: 50, state: "open", body: markerFor(key) }]);
  await runReport({ triageDir: await triaged(), diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile: join(tmp(), "s.md"), agent });
  assert.deepEqual(gh.calls.map((c) => c.slice(0, 2)), [["list", "flaky-test"], ["comment", 50]]);

  // Triage saw it closed, and another report has reopened it and started an agent since.
  const closed = [{ number: 3, state: "closed", state_reason: "completed", body: markerFor(key), updated_at: "2026-01-01" }];
  gh = new FakeGitHub([{ ...closed[0], state: "open", state_reason: "reopened" }]);
  await runReport({ triageDir: await triaged(closed), diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile: join(tmp(), "s.md"), agent });
  assert.deepEqual(gh.calls.map((c) => c[0]), ["list", "comment"]);
});

test("a dry run with an agent workflow says it would start one", async () => {
  const summaryFile = join(tmp(), "s.md");
  const gh = new FakeGitHub();
  await runReport({ triageDir: await triaged(), diagnosesDir: tmp(), label: "flaky-test", dryRun: true, gh, ctx, summaryFile, agent });
  assert.deepEqual(gh.calls, []);
  assert.match(readFileSync(summaryFile, "utf8"), /would open an issue and start agent-ready\.yml/);
});

test("triage fails clearly when no shard uploaded anything", async () => {
  await assert.rejects(
    runTriage({ resultsDir: join(tmp(), "never-downloaded"), outDir: tmp(), workingDirectory: ".", label: "l", maxDiagnoses: 1, canDiagnose: false, gh: new FakeGitHub(), template: "" }),
    /No run reported any tests \(0 runs\)/,
  );
});

// Grouping by cause: one run, and one PR, per cause.

const rateLimited = (pid) =>
  `  1) test x (Demo.Test)\n     test/demo_test.exs:3\n     ** (DBConnection.ConnectionError) client #PID<0.${pid}.0> timed out after ${pid}ms\n     stacktrace:\n       (demo 0.1.0) lib/demo/rate_limit.ex:42: Demo.RateLimit.hit/2\n       test/demo_test.exs:5: (test)\n`;
const ownFailure = (name) => `  1) test ${name} (Demo.Test)\n     test/demo_test.exs:3\n     Assertion with == failed\n     code:  assert ${name}() == 2\n     stacktrace:\n       test/demo_test.exs:4: (test)\n`;

// Three flakes: a and b fail the same way, and c its own way.
async function triagedGroups(issues = [], messages = { a: rateLimited(412), b: rateLimited(977), c: ownFailure("c") }) {
  const results = tmp();
  const lines = [];
  for (const run of [1, 2]) {
    for (const [n, message] of Object.entries(messages)) lines.push(t(`test ${n}`, run, run === 2 ? "failed" : "passed", run === 2 ? { message } : {}));
    lines.push(r(run, Object.keys(messages).length));
  }
  writeResults(results, 1, lines);
  const out = tmp();
  await runTriage({ resultsDir: results, outDir: out, workingDirectory: ".", label: "flaky-test", maxDiagnoses: 0, canDiagnose: false, gh: new FakeGitHub(issues), template: "" });
  return out;
}
const report = async (gh, triageDir, over = {}) => {
  const summaryFile = join(tmp(), "s.md");
  await runReport({ triageDir, diagnosesDir: tmp(), label: "flaky-test", dryRun: false, gh, ctx, summaryFile, agent, ...over });
  return readFileSync(summaryFile, "utf8");
};
const keyOf = (n) => `::Demo.Test::test ${n}`;

test("flakes that fail the same way make one group: one run, on the first, which lists the others", async () => {
  const gh = new FakeGitHub();
  const summary = await report(gh, await triagedGroups());

  const created = gh.calls.filter((c) => c[0] === "create").map((c) => c[1]);
  assert.deepEqual(created.map((c) => [c.title, c.labels]), [
    ['Flaky test: Demo.Test "a"', ["flaky-test", "agent-ready"]],
    ['Flaky test: Demo.Test "b"', ["flaky-test"]],
    ['Flaky test: Demo.Test "c"', ["flaky-test", "agent-ready"]],
  ]);
  // b points at a, the first issue (#50), in its body.
  assert.match(created[1].body, /Likely the same cause as #50/);
  assert.match(created[1].body, /<!-- flake-hunt-lead:50 -->/);
  assert.ok(created[1].body.trimEnd().endsWith(markerFor(keyOf("b"))), "the key marker stays last");
  // Then a's body lists b, before a's run starts.
  const edits = gh.calls.filter((c) => c[0] === "setBody");
  assert.deepEqual(edits.map((c) => c[1]), [50]);
  assert.match(edits[0][2], /### Likely the same cause\n\n#51 flaked/);
  assert.match(edits[0][2], /<!-- flake-hunt-group:51 -->/);
  assert.ok(gh.calls.indexOf(edits[0]) < gh.calls.findIndex((c) => c[0] === "dispatch"));
  assert.deepEqual(gh.calls.filter((c) => c[0] === "dispatch").map((c) => c[3]), [{ issue: "50" }, { issue: "52" }]);
  assert.match(summary, /opened #50 and started agent-ready\.yml, for it and #51/);
  assert.match(summary, /opened #51, likely the same cause as #50/);
});

test("flakes that fail in different ways stay apart, each with a run of its own", async () => {
  const gh = new FakeGitHub();
  await report(gh, await triagedGroups([], { a: ownFailure("a"), b: ownFailure("b") }));
  assert.deepEqual(gh.calls.filter((c) => c[0] === "dispatch").map((c) => c[3]), [{ issue: "50" }, { issue: "51" }]);
  assert.ok(!gh.calls.some((c) => c[0] === "setBody"));
  assert.ok(gh.calls.filter((c) => c[0] === "create").every((c) => !/same cause/.test(c[1].body)));
});

test("without an agent workflow nothing is grouped", async () => {
  const gh = new FakeGitHub();
  await report(gh, await triagedGroups(), { agent: null });
  assert.ok(gh.calls.filter((c) => c[0] === "create").every((c) => !/same cause/.test(c[1].body)));
  assert.ok(!gh.calls.some((c) => c[0] === "setBody"));
});

test("a reopened flake joins a group the same way a new one does", async () => {
  const closed = [{ number: 3, state: "closed", state_reason: "completed", body: `Old body.\n\n${markerFor(keyOf("b"))}\n`, updated_at: "2026-01-01" }];
  const gh = new FakeGitHub(closed);
  await report(gh, await triagedGroups(closed));

  const ops = gh.calls.filter((c) => c[0] !== "label" && c[0] !== "list");
  // a is first and new; b is reopened behind it, with no label and no run.
  assert.deepEqual(ops.map((c) => c.slice(0, 2).map((x) => (typeof x === "object" ? x.title : x))), [
    ["create", 'Flaky test: Demo.Test "a"'],
    ["comment", 3],
    ["setBody", 3],
    ["reopen", 3],
    ["setBody", 50],
    ["dispatch", "agent-ready.yml"],
    ["create", 'Flaky test: Demo.Test "c"'],
    ["dispatch", "agent-ready.yml"],
  ]);
  assert.match(ops[1][2], /Flaky again[\s\S]*Likely the same cause as #50/);
  assert.match(ops[2][2], /^Old body\.[\s\S]*<!-- flake-hunt-lead:50 -->\n\n<!-- flake-hunt:/);
  assert.match(ops[4][2], /<!-- flake-hunt-group:3 -->/);
  assert.ok(!gh.calls.some((c) => c[0] === "addLabels" && c[1] === 3));
});

test("a reopened flake that leads a group lists the others, in place of any list from before", async () => {
  const old = `Old body.\n\n<!-- flake-hunt-same-cause -->\n### Likely the same cause\n\nstale\n\n<!-- flake-hunt-group:1,2 -->\n\n${markerFor(keyOf("a"))}\n`;
  const closed = [{ number: 3, state: "closed", state_reason: "completed", body: old, updated_at: "2026-01-01" }];
  const gh = new FakeGitHub(closed);
  await report(gh, await triagedGroups(closed));
  const edit = gh.calls.find((c) => c[0] === "setBody" && c[1] === 3)[2];
  assert.doesNotMatch(edit, /stale|group:1,2/);
  assert.match(edit, /<!-- flake-hunt-group:50 -->/);
  assert.deepEqual(gh.calls.find((c) => c[0] === "addLabels"), ["addLabels", 3, ["agent-ready"]]);
  assert.deepEqual(gh.calls.filter((c) => c[0] === "dispatch").map((c) => c[3]), [{ issue: "3" }, { issue: "51" }]);
});

test("rerunning a report doesn't regroup or start anything again", async () => {
  const triageDir = await triagedGroups();
  const first = new FakeGitHub();
  await report(first, triageDir);
  // The issues as the first report left them.
  const bodies = new Map(first.calls.filter((c) => c[0] === "create").map((c, i) => [50 + i, c[1].body]));
  for (const [, n, body] of first.calls.filter((c) => c[0] === "setBody")) bodies.set(n, body);
  const now = [...bodies].map(([number, body]) => ({ number, state: "open", body }));

  const again = new FakeGitHub(now);
  await report(again, triageDir);
  assert.deepEqual(again.calls.map((c) => c.slice(0, 2)), [["list", "flaky-test"], ["comment", 50], ["comment", 51], ["comment", 52]]);
});

test("once a group's first issue is closed, an issue left open in it gets a run of its own", async () => {
  const lead = { number: 50, state: "closed", state_reason: "completed", body: `x\n\n<!-- flake-hunt-group:51 -->\n\n${markerFor(keyOf("z"))}\n`, updated_at: "2026-01-01" };
  const follower = { number: 51, state: "open", body: `Body.\n\n<!-- flake-hunt-same-cause -->\n### Likely the same cause\n\nold\n\n<!-- flake-hunt-lead:50 -->\n\n${markerFor(keyOf("b"))}\n` };
  const issues = [lead, follower];
  const gh = new FakeGitHub(issues);
  const summary = await report(gh, await triagedGroups(issues, { b: ownFailure("b") }));
  const ops = gh.calls.filter((c) => c[0] !== "list");
  assert.deepEqual(ops.map((c) => c.slice(0, 2)), [["addLabels", 51], ["comment", 51], ["setBody", 51], ["dispatch", "agent-ready.yml"]]);
  assert.match(ops[1][2], /#50 is closed and this still flakes/);
  assert.equal(ops[2][2], `Body.\n\n${markerFor(keyOf("b"))}\n`);
  assert.match(summary, /commented on #51 and started agent-ready\.yml: #50 is closed/);

  // While the first issue is open, it's only a comment.
  const waiting = new FakeGitHub([{ ...lead, state: "open" }, follower]);
  await report(waiting, await triagedGroups([{ ...lead, state: "open" }, follower], { b: ownFailure("b") }));
  assert.deepEqual(waiting.calls.map((c) => c[0]), ["list", "comment"]);
});

test("when a group's first issue can't be opened, the next one leads", async () => {
  const gh = new FakeGitHub();
  let first = true;
  gh.createIssue = async (issue) => {
    gh.calls.push(["create", issue]);
    if (first) {
      first = false;
      throw new Error("GitHub 502");
    }
    return { number: gh.next++ };
  };
  await assert.rejects(report(gh, await triagedGroups([], { a: rateLimited(1), b: rateLimited(2) })), /1 of 2 issue updates failed/);
  const created = gh.calls.filter((c) => c[0] === "create").map((c) => c[1]);
  assert.deepEqual(created.map((c) => c.labels), [["flaky-test", "agent-ready"], ["flaky-test", "agent-ready"]]);
  assert.deepEqual(gh.calls.filter((c) => c[0] === "dispatch").map((c) => c[3]), [{ issue: "50" }]);
});

test("a dry run says which flakes it would group", async () => {
  const gh = new FakeGitHub();
  const summaryFile = join(tmp(), "s.md");
  await runReport({ triageDir: await triagedGroups(), diagnosesDir: tmp(), label: "flaky-test", dryRun: true, gh, ctx, summaryFile, agent });
  assert.deepEqual(gh.calls, []);
  const summary = readFileSync(summaryFile, "utf8");
  assert.match(summary, /Demo.Test "b" \| 1\/2 \| would open an issue, likely the same cause as Demo.Test "a"/);
  assert.match(summary, /Demo.Test "a" \| 1\/2 \| would open an issue and start agent-ready\.yml, for it and 1 more/);
});

test("a group's first issue that flakes again regroups with its open others, and starts one run", async () => {
  const lead = { number: 50, state: "closed", state_reason: "completed", body: `x\n\n<!-- flake-hunt-same-cause -->\n### Likely the same cause\n\nold\n\n<!-- flake-hunt-group:51 -->\n\n${markerFor(keyOf("a"))}\n`, updated_at: "2026-01-01" };
  const follower = { number: 51, state: "open", body: `y\n\n<!-- flake-hunt-same-cause -->\n### Likely the same cause\n\nold\n\n<!-- flake-hunt-lead:50 -->\n\n${markerFor(keyOf("b"))}\n` };
  const issues = [lead, follower];
  const gh = new FakeGitHub(issues);
  await report(gh, await triagedGroups(issues, { a: rateLimited(1), b: rateLimited(2) }));
  assert.deepEqual(gh.calls.filter((c) => c[0] === "dispatch").map((c) => c[3]), [{ issue: "50" }]);
  const lists = gh.calls.filter((c) => c[0] === "setBody" && c[1] === 50);
  assert.match(lists.at(-1)[2], /<!-- flake-hunt-group:51 -->/);
  assert.ok(!gh.calls.some((c) => c[0] === "addLabels" && c[1] === 51));
});

test("a promotion labels the issue before it takes the pointer out, so a rerun can finish it", async () => {
  const lead = { number: 50, state: "closed", state_reason: "completed", body: `x\n\n${markerFor(keyOf("z"))}\n`, updated_at: "2026-01-01" };
  const follower = { number: 51, state: "open", body: `Body.\n\n<!-- flake-hunt-same-cause -->\n### Likely the same cause\n\nold\n\n<!-- flake-hunt-lead:50 -->\n\n${markerFor(keyOf("b"))}\n` };
  const gh = new FakeGitHub([lead, follower]);
  await report(gh, await triagedGroups([lead, follower], { b: ownFailure("b") }));
  const ops = gh.calls.map((c) => c[0]);
  assert.ok(ops.indexOf("addLabels") < ops.indexOf("setBody"));
});

test("a reopened follower gets its pointer before it's reopened", async () => {
  const closed = [{ number: 3, state: "closed", state_reason: "completed", body: `Old body.\n\n${markerFor(keyOf("b"))}\n`, updated_at: "2026-01-01" }];
  const gh = new FakeGitHub(closed);
  await report(gh, await triagedGroups(closed));
  const on3 = gh.calls.filter((c) => c[1] === 3).map((c) => c[0]);
  assert.ok(on3.indexOf("setBody") < on3.indexOf("reopen"));
});

test("a group whose first issue can't list the others fails the report, and still starts its run", async () => {
  const gh = new FakeGitHub();
  gh.setBody = async () => {
    throw new Error("GitHub 502");
  };
  await assert.rejects(report(gh, await triagedGroups()), /1 of 3 issue updates failed/);
  assert.deepEqual(gh.calls.filter((c) => c[0] === "dispatch").map((c) => c[3]), [{ issue: "50" }, { issue: "52" }]);
});
