import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFailureLog, parseFailureAnnotations, attributeFailures, diagnosticHash, failureContext, validFailureContext } from "../lib/failure-report.mjs";
import { A, B, C } from "./fixtures.mjs";

export const exunit = ({ name = "a tip reaches the log", left = "[]", right = "[150]", line = 4, extra = "", count = 1 } = {}) => `
2026-11-10T13:50:31.6707415Z Running ExUnit with seed: 655803, max_cases: 8
2026-11-10T13:50:31.7218353Z   1) test ${name} (Tipper.TipLogTest)
2026-11-10T13:50:31.7237640Z ##[error]     test/tipper/tip_log_test.exs:${line}
2026-11-10T13:50:31.7243220Z      Assertion with == failed
2026-11-10T13:50:31.7243437Z      code:  assert Agent.get(log, & &1) == ${right}
2026-11-10T13:50:31.7243615Z      left:  ${left}
2026-11-10T13:50:31.7243772Z      right: ${right}
2026-11-10T13:50:31.7243928Z      stacktrace:
2026-11-10T13:50:31.7244074Z        test/tipper/tip_log_test.exs:13: (test)
${extra}
2026-11-10T13:50:31.8484602Z Result: 15/16 passed
2026-11-10T13:50:31.8484746Z Failed: ${count} test${count === 1 ? "" : "s"}
2026-11-10T13:50:31.8558631Z ##[error]Process completed with exit code 2.
`;
const checks = (sha, report, { appId = 1, name = "test", state = "failure" } = {}) => ({ headSha: sha, state,
  records: [{ observations: [{ kind: "check", name, appId, state }] }], failed: state === "failure" ? [{
    kind: "check", id: 1, name, appId, diagnostics: report.diagnostics, completeEvidence: report.complete,
  }] : [] });

test("the complete ExUnit step retains assertion values while excluding seed, timing and line movement", () => {
  const first = parseFailureLog(exunit());
  assert.equal(first.complete, true); assert.equal(first.diagnostics.length, 1);
  assert.equal(first.diagnostics[0].path, "test/tipper/tip_log_test.exs");
  const moved = parseFailureLog(exunit({ line: 40 }).replaceAll("655803", "42").replaceAll("13:50:31", "13:50:49"));
  assert.equal(first.diagnostics[0].signature, moved.diagnostics[0].signature);
  assert.notEqual(first.diagnostics[0].signature, parseFailureLog(exunit({ right: "[500]" })).diagnostics[0].signature);
});

test("incomplete test counts, unknown errors and generic annotations never establish an entire shared failure", () => {
  assert.equal(parseFailureLog(exunit({ count: 2 })).complete, false);
  assert.equal(parseFailureLog("Process completed with exit code 1.").complete, false);
  assert.equal(parseFailureLog("src/file.ts(3,4): error TS2339: Property x is missing\nerror: another unclassified compiler").complete, false);
  assert.equal(parseFailureLog("src/file.ts(3,4): error TS2339: Property x is missing\nFATAL: another failure").complete, false);
  assert.equal(parseFailureLog("src/file.ts(3,4): error TS2339: Property x is missing\nFound 2 errors").complete, false);
  assert.equal(parseFailureAnnotations([{ annotation_level: "failure", path: ".github", message: "Process completed with exit code 2." }], 1).complete, false);
  assert.equal(parseFailureAnnotations([{ annotation_level: "failure", path: "test/a_test.exs", message: "test example (Test)" }], 1).complete, false);
});

test("compiler signatures identify the file, error and message rather than the check's title", () => {
  const compile = (message) => parseFailureLog(`== Compilation error in file lib/gate.ex ==\n** (CompileError) lib/gate.ex:12: ${message}`);
  const missing = compile("undefined function session_key/0 (there is no such import)");
  assert.equal(missing.complete, true);
  assert.notEqual(missing.diagnostics[0].signature, compile("undefined function other_key/0 (there is no such import)").diagnostics[0].signature);
  assert.equal(compile("cannot compile module (errors have been logged)").complete, false);
});

test("matching requires exact base and provider evidence, and mixed diagnostics retain independent failures", () => {
  const base = checks(A, parseFailureLog(exunit()));
  const same = attributeFailures(checks(B, parseFailureLog(exunit())), base, A);
  assert.equal(same.failed[0].sharedMain, true);
  for (const other of [checks(A, parseFailureLog(exunit({ right: "[500]" }))), checks(A, parseFailureLog(exunit()), { appId: 2 })]) {
    assert.notEqual(attributeFailures(checks(B, parseFailureLog(exunit())), other, A).failed[0].attribution, "shared-main");
  }
  assert.equal(attributeFailures(checks(B, parseFailureLog(exunit())), base, C).failed[0].attribution, "unknown");
  const report = parseFailureLog(exunit()), second = parseFailureLog(exunit({ name: "another behavior", right: "[500]" }));
  const mixed = attributeFailures(checks(B, { complete: true, diagnostics: [...report.diagnostics, ...second.diagnostics] }), base, A);
  assert.equal(mixed.failed[0].attribution, "pr-specific");
  assert.deepEqual(mixed.failed[0].diagnostics.map((d) => d.sharedMain), [true, false]);
});

test("an independently green base check permits PR diagnosis even when another main check fails", () => {
  const base = checks(A, parseFailureLog(exunit()));
  base.records.push({ observations: [{ kind: "check", name: "lint", appId: 1, state: "success" }] });
  const pr = checks(B, { complete: false, diagnostics: [] }, { name: "lint" });
  assert.equal(attributeFailures(pr, base, A).failed[0].attribution, "pr-specific");
});

test("operation context binds failure evidence to the recorded commits without asserting CI passed", () => {
  const report = parseFailureLog(exunit());
  const context = failureContext({ main: { sha: A, checks: checks(A, report), repairIssue: 20 }, prs: [
    { number: 9, headSha: B, baseSha: A, checks: attributeFailures(checks(B, report), checks(A, report), A) },
  ] }, 9);
  const op = { base: { sha: A }, target: { number: 9, head: B } };
  assert.equal(validFailureContext(context, op), true);
  assert.equal(context.main.state, "failure"); assert.equal(context.pr.failures[0].diagnostics[0].sharedMain, true);
  assert.equal(validFailureContext(context, { ...op, base: { sha: C } }), false);
});
