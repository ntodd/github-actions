import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetupOptions, validateSetupCi, resolveSetupChecks, validateSharedSetupWorkflow } from "../lib/setup-options.mjs";

test("setup options keep preview and activation explicit and reject ambiguous inputs", () => {
  const options = parseSetupOptions(["--preview", "--ci", "CI", "--check", "test@15368", "ntodd/project"]);
  assert.equal(options.preview, true); assert.equal(options.activate, false);
  assert.deepEqual(options.check, ["test@15368"]);
  for (const args of [["ntodd/project", "other/project"], ["--ci"], ["--unknown", "ntodd/project"],
    ["--check", "test", "--checks", "checks.json", "ntodd/project"], ["../../etc/passwd"]]) assert.throws(() => parseSetupOptions(args));
});

test("bootstrap requires an immutable runtime ref and does not imply App credentials, checks or activation", () => {
  const ref = "a".repeat(40);
  const options = parseSetupOptions(["--bootstrap", "--preview", "--ref", ref, "ntodd/project"]);
  assert.equal(options.bootstrap, true); assert.equal(options.activate, false); assert.equal(options.appDir, undefined);
  for (const args of [[], ["--ref", "main"], ["--ref", ref, "--activate"], ["--ref", ref, "--app-dir", "/tmp/key"],
    ["--ref", ref, "--check", "test"]]) assert.throws(() => parseSetupOptions(["--bootstrap", ...args, "ntodd/project"]), /Bootstrap needs/);
});

test("setup CI validation requires PR and default-branch push entry points", () => {
  validateSetupCi("name: CI\non:\n  pull_request:\n  push:\njobs: {}", "CI");
  validateSetupCi("on: [pull_request, push]", "CI");
  for (const source of ["on: pull_request_target", "on: [push]", "on: [pull_request]", "on: [push]\non: [pull_request]"]) {
    assert.throws(() => validateSetupCi(source, "CI"));
  }
});

test("required checks bind to a unique observed App or an explicitly supplied App ID", () => {
  const facts = { checks: [{ name: "test", app: { id: 123 } }, { name: "test", app: { id: 123 } }], statuses: [{ context: "legacy" }] };
  assert.deepEqual(resolveSetupChecks(["test", "legacy", "other@456"], facts), [
    { context: "test", integration_id: 123 }, { context: "legacy" }, { context: "other", integration_id: 456 },
  ]);
  facts.checks.push({ name: "test", app: { id: 999 } });
  assert.throws(() => resolveSetupChecks(["test"], facts));
  assert.throws(() => resolveSetupChecks(["missing"], facts));
});

test("setup verifies that both selected shared workflows can actually be called", () => {
  validateSharedSetupWorkflow("on:\n  workflow_call:\n", "factory-runtime");
  assert.throws(() => validateSharedSetupWorkflow("on: [push]", "factory-runtime"));
});
