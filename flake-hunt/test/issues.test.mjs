import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keyFromBody,
  markerFor,
  planIssues,
  renderComment,
  renderIssue,
  renderSummary,
  titleFor,
} from "../lib/issues.mjs";

const flake = (over = {}) => ({
  key: "apps/crew::Crew.FooTest::test it works",
  module: "Crew.FooTest",
  name: "test it works",
  file: "test/foo_test.exs",
  line: 12,
  runs: 100,
  failures: 3,
  failedRuns: [
    { seed: 111, shard: 1, run: 4, message: "Assertion with == failed" },
    { seed: 222, shard: 2, run: 9, message: "Assertion with == failed" },
    { seed: 333, shard: 3, run: 1, message: "** (exit) timeout" },
  ],
  ...over,
});

const ctx = {
  repo: "ntodd/crew",
  sha: "0123456789abcdef0123456789abcdef01234567",
  serverUrl: "https://github.com",
  runUrl: "https://github.com/ntodd/crew/actions/runs/42",
  workingDirectory: "apps/crew",
};

test("the marker round-trips keys with spaces and odd characters", () => {
  const key = "apps/crew::Crew.FooTest::test handles --> and \"quotes\"";
  const body = `some text\n\n${markerFor(key)}\n`;
  assert.equal(keyFromBody(body), key);
  assert.equal(keyFromBody("no marker here"), null);
  assert.equal(keyFromBody(null), null);
});

test("planIssues creates, comments, reopens or skips", () => {
  const a = flake({ key: "k::A::test a" });
  const b = flake({ key: "k::B::test b" });
  const c = flake({ key: "k::C::test c" });
  const d = flake({ key: "k::D::test d" });
  const issues = [
    { number: 1, state: "open", body: markerFor(b.key) },
    { number: 2, state: "closed", state_reason: "completed", body: markerFor(c.key), updated_at: "2026-01-01T00:00:00Z" },
    { number: 3, state: "closed", state_reason: "not_planned", body: markerFor(d.key) },
    { number: 4, state: "closed", state_reason: "completed", body: "unrelated" },
  ];

  const plan = planIssues([a, b, c, d], issues);

  assert.deepEqual(
    plan.map((p) => [p.flake.key, p.action, p.issue?.number ?? null]),
    [
      [a.key, "create", null],
      [b.key, "comment", 1],
      [c.key, "reopen", 2],
      [d.key, "skip", 3],
    ],
  );
});

test("planIssues prefers an open issue, then the latest closed one", () => {
  const f = flake();
  const issues = [
    { number: 5, state: "closed", state_reason: "completed", body: markerFor(f.key), updated_at: "2026-01-01T00:00:00Z" },
    { number: 6, state: "closed", state_reason: "completed", body: markerFor(f.key), updated_at: "2026-03-01T00:00:00Z" },
  ];
  assert.equal(planIssues([f], issues)[0].issue.number, 6);
  issues.push({ number: 7, state: "open", body: markerFor(f.key) });
  assert.deepEqual(
    [planIssues([f], issues)[0].action, planIssues([f], issues)[0].issue.number],
    ["comment", 7],
  );
});

test("titleFor names the test and module, prefixed by a non-root working directory", () => {
  assert.equal(titleFor(flake(), "apps/crew"), "[apps/crew] Flaky test: Crew.FooTest \"it works\"");
  assert.equal(titleFor(flake(), "."), "Flaky test: Crew.FooTest \"it works\"");
  assert.equal(titleFor(flake({ name: "doctest Foo.bar/1 (1)" }), "."), "Flaky test: Crew.FooTest \"doctest Foo.bar/1 (1)\"");
  assert.ok(titleFor(flake({ name: "test " + "x".repeat(400) }), ".").length <= 256);
});

test("renderIssue links the test, shows the rate, seeds, repro and marker", () => {
  const body = renderIssue(flake(), ctx, null);
  assert.match(body, /\[`test\/foo_test\.exs:12`\]\(https:\/\/github\.com\/ntodd\/crew\/blob\/0123456789abcdef0123456789abcdef01234567\/apps\/crew\/test\/foo_test\.exs#L12\)/);
  assert.match(body, /Failed \*\*3 of 100\*\* runs \(3%\)/);
  assert.match(body, /cd apps\/crew/);
  assert.match(body, /mix test --seed 111/);
  assert.match(body, /mix test test\/foo_test\.exs:12 --repeat-until-failure 500/);
  assert.match(body, /111, 222, 333/);
  assert.match(body, /\*\* \(exit\) timeout/);
  assert.ok(body.trimEnd().endsWith(markerFor(flake().key)));
  assert.doesNotMatch(body, /### Diagnosis/);
});

test("renderIssue dedupes identical failure messages", () => {
  const body = renderIssue(flake(), ctx, null);
  assert.equal(body.split("Assertion with == failed").length - 1, 1);
});

test("renderIssue includes a diagnosis when there is one", () => {
  const body = renderIssue(flake(), ctx, "**Likely cause:** shared ETS table.");
  assert.match(body, /### Diagnosis/);
  assert.match(body, /shared ETS table/);
});

test("renderIssue fences messages that contain backticks", () => {
  const body = renderIssue(flake({ failedRuns: [{ seed: 1, shard: 1, run: 1, message: "```\nnasty\n```" }] }), ctx, null);
  assert.match(body, /````\n```\nnasty\n```\n````/);
});

test("renderIssue omits the cd for a root project", () => {
  const body = renderIssue(flake(), { ...ctx, workingDirectory: "." }, null);
  assert.doesNotMatch(body, /\ncd /);
  assert.match(body, /blob\/0123456789abcdef0123456789abcdef01234567\/test\/foo_test\.exs#L12/);
});

test("renderComment reports the new rate, and says when the issue was reopened", () => {
  const plain = renderComment(flake(), ctx, { reopened: false, diagnosis: null });
  assert.match(plain, /Still flaky/);
  assert.match(plain, /3 of 100/);
  assert.match(plain, /0123456/);
  const reopened = renderComment(flake(), ctx, { reopened: true, diagnosis: "cause" });
  assert.match(reopened, /Flaky again/);
  assert.match(reopened, /### Diagnosis/);
});

test("renderSummary lists outcomes, broken tests and dry runs", () => {
  const md = renderSummary({
    workingDirectory: "apps/crew",
    runs: { total: 100, reported: 99, errored: 1 },
    testCount: 250,
    dryRun: true,
    diagnosis: "skipped: no Claude token",
    results: [
      { flake: flake(), action: "create", issue: null },
      { flake: flake({ key: "x", name: "test b", failures: 1 }), action: "comment", issue: { number: 7 } },
    ],
    broken: [flake({ key: "y", name: "test always", failures: 100 })],
  });
  assert.match(md, /apps\/crew/);
  assert.match(md, /Dry run/);
  assert.match(md, /99 of 100 runs/);
  assert.match(md, /would open an issue/);
  assert.match(md, /would comment on #7/);
  assert.match(md, /Failed every run/);
  assert.match(md, /Crew.FooTest "always"/);
  assert.match(md, /1 run reported nothing/);
  assert.match(md, /no Claude token/);
});

test("renderSummary says plainly when nothing flaked", () => {
  const md = renderSummary({
    workingDirectory: ".",
    runs: { total: 10, reported: 10, errored: 0 },
    testCount: 5,
    dryRun: false,
    diagnosis: null,
    results: [],
    broken: [],
  });
  assert.match(md, /No flaky tests/);
});
