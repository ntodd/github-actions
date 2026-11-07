import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, classify, keyOf, parseJsonl } from "../lib/aggregate.mjs";

const rec = (over) => ({
  type: "test",
  module: "MyApp.FooTest",
  name: "test it works",
  file: "test/foo_test.exs",
  line: 4,
  status: "passed",
  seed: 1,
  run: 1,
  shard: 1,
  ...over,
});

const run = (over) => ({ type: "run", shard: 1, run: 1, exit: 0, tests: 1, ...over });

test("keyOf drops a root working directory and normalizes paths", () => {
  assert.equal(keyOf(".", "A", "test x"), "::A::test x");
  assert.equal(keyOf("", "A", "test x"), "::A::test x");
  assert.equal(keyOf("./apps/crew/", "A", "test x"), "apps/crew::A::test x");
});

test("parseJsonl skips blank lines and reports bad ones", () => {
  const bad = [];
  const out = parseJsonl('{"a":1}\n\n not json\n{"b":2}\n', (line) => bad.push(line));
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(bad, [" not json"]);
});

test("aggregate counts runs and failures per test", () => {
  const records = [
    run({ run: 1 }),
    run({ run: 2, exit: 2 }),
    rec({ run: 1, seed: 11 }),
    rec({ run: 2, seed: 22, status: "failed", message: "boom" }),
    rec({ run: 1, seed: 11, name: "test other" }),
    rec({ run: 2, seed: 22, name: "test other" }),
  ];

  const result = aggregate(records, { workingDirectory: "apps/crew" });

  assert.deepEqual(result.runs, { total: 2, reported: 2, errored: 0 });
  const flaky = result.tests.find((t) => t.name === "test it works");
  assert.equal(flaky.key, "apps/crew::MyApp.FooTest::test it works");
  assert.equal(flaky.runs, 2);
  assert.equal(flaky.failures, 1);
  assert.deepEqual(flaky.failedRuns, [{ seed: 22, shard: 1, run: 2, message: "boom" }]);
  assert.equal(flaky.file, "test/foo_test.exs");
  assert.equal(flaky.line, 4);
  assert.equal(result.tests.find((t) => t.name === "test other").failures, 0);
});

test("a run that reported no tests is an errored run", () => {
  const result = aggregate([run({ run: 1, tests: 0, exit: 1 }), run({ run: 2 }), rec({ run: 2 })], {
    workingDirectory: ".",
  });
  assert.deepEqual(result.runs, { total: 2, reported: 1, errored: 1 });
});

test("the same test in different shards is one test", () => {
  const result = aggregate(
    [rec({ shard: 1 }), rec({ shard: 2, status: "failed", message: "x" }), rec({ shard: 3 })],
    { workingDirectory: "." },
  );
  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].runs, 3);
  assert.equal(result.tests[0].failures, 1);
});

test("classify splits flaky from broken and sorts flaky by failure rate", () => {
  const tests = [
    { key: "a", runs: 10, failures: 0 },
    { key: "b", runs: 10, failures: 1 },
    { key: "c", runs: 10, failures: 10 },
    { key: "d", runs: 4, failures: 2 },
  ];
  const { flaky, broken } = classify(tests);
  assert.deepEqual(
    flaky.map((t) => t.key),
    ["d", "b"],
  );
  assert.deepEqual(
    broken.map((t) => t.key),
    ["c"],
  );
});
