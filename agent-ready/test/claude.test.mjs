// lib/claude.mjs against a stub `claude` that records how it was called
// and acts out a plan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRunner, streamLine } from "../lib/claude.mjs";

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const n = Number(fs.existsSync(process.env.STUB_COUNT) ? fs.readFileSync(process.env.STUB_COUNT, "utf8") : 0);
fs.writeFileSync(process.env.STUB_COUNT, String(n + 1));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: process.argv.slice(2), gh: process.env.GH_TOKEN ?? null, github: process.env.GITHUB_TOKEN ?? null, key: process.env.AGENT_APP_PRIVATE_KEY ?? null, state: process.env.AGENT_STATE }) + "\\n");
const step = JSON.parse(process.env.STUB_PLAN)[n] ?? {};
const state = process.env.AGENT_STATE;
if (step.outcome) fs.writeFileSync(path.join(state, "outcome.json"), JSON.stringify(step.outcome));
if (step.comment) fs.writeFileSync(path.join(state, "comment.md"), step.comment);
if (step.report) fs.writeFileSync(path.join(state, "report.md"), step.report);
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "mix test" } }] } }));
const finish = () => {
  console.log(JSON.stringify({ type: "result", subtype: step.subtype ?? "success", is_error: false, num_turns: 4, total_cost_usd: step.cost ?? 1.25, session_id: "s" }));
  process.exit(step.exit ?? 0);
};
step.sleep ? setTimeout(finish, step.sleep) : finish();
`;

function setup(plan, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  const state = join(dir, "state");
  const log = join(dir, "log.jsonl");
  const env = { ...process.env, STUB_LOG: log, STUB_COUNT: join(dir, "count"), STUB_PLAN: JSON.stringify(plan), GITHUB_TOKEN: "ghs_job", AGENT_APP_PRIVATE_KEY: "pem" };
  const lines = [];
  const run = claudeRunner({
    bin,
    sessionId: "11111111-2222-3333-4444-555555555555",
    stateDir: state,
    cwd: dir,
    model: "claude-opus-5-5",
    effort: "medium",
    maxTurns: 300,
    systemPromptFile: "/tools/system.md",
    mcpConfig: "/tools/mcp.json",
    env,
    timeoutMs: 5_000,
    log: (l) => lines.push(l),
    ...extra,
  });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { run, calls, lines, state };
}

test("the first phase starts the session and later ones resume it, each with that phase's token", async () => {
  const s = setup([{ outcome: { status: "ready" } }, { outcome: { status: "published", prs: [3] } }]);
  const a = await s.run({ phase: "build", token: "ghs_read", prompt: "build it" });
  const b = await s.run({ phase: "publish", token: "ghs_write", prompt: "push it" });
  assert.deepEqual(a, { outcome: { status: "ready" }, turns: 4, cost: 1.25 });
  assert.deepEqual(b.outcome, { status: "published", prs: [3] });

  const [first, second] = s.calls();
  assert.deepEqual(first.args.slice(0, 2), ["-p", "build it"]);
  for (const flag of [
    ["--output-format", "stream-json"],
    ["--model", "claude-opus-5-5"],
    ["--effort", "medium"],
    ["--max-turns", "300"],
    ["--append-system-prompt-file", "/tools/system.md"],
    ["--mcp-config", "/tools/mcp.json"],
  ]) {
    const i = first.args.indexOf(flag[0]);
    assert.equal(first.args[i + 1], flag[1], flag[0]);
  }
  assert.ok(first.args.includes("--dangerously-skip-permissions"));
  assert.ok(first.args.includes("--verbose"));
  assert.equal(first.args[first.args.indexOf("--session-id") + 1], "11111111-2222-3333-4444-555555555555");
  assert.equal(second.args[second.args.indexOf("--resume") + 1], "11111111-2222-3333-4444-555555555555");
  assert.ok(!second.args.includes("--session-id"));

  assert.deepEqual([first.gh, second.gh], ["ghs_read", "ghs_write"]);
  assert.equal(first.github, null, "the job's GITHUB_TOKEN isn't passed on");
  assert.equal(first.key, null, "nor the App key");
  assert.equal(first.state, s.state);
});

test("a resumed session reports its running cost, so each phase gets only its own share", async () => {
  const s = setup([{ outcome: { status: "ready" }, cost: 1.0 }, { outcome: { status: "published", prs: [1] }, cost: 1.25 }]);
  assert.equal((await s.run({ phase: "build", token: "t", prompt: "p" })).cost, 1.0);
  assert.equal((await s.run({ phase: "publish", token: "t", prompt: "p" })).cost, 0.25);
});

test("invocation measurements include missing-outcome retries and unsuccessful outcomes", async () => {
  const measurements = [];
  const s = setup([{ cost: 1 }, { cost: 1.25, outcome: { status: "failed" }, exit: 1 }], { onInvocation: (m) => measurements.push(m) });
  assert.equal((await s.run({ phase: "work", token: "t", prompt: "p" })).outcome.status, "failed");
  assert.equal(measurements.length, 2);
  assert.equal(measurements[0].result.total_cost_usd, 1);
  assert.equal(measurements[1].result.total_cost_usd, 1.25);
  assert.equal(measurements[1].completed, true);
});

test("comment.md and report.md ride along on the outcome, and stale files are cleared first", async () => {
  const s = setup([{ outcome: { status: "blocked" }, comment: "Which one?" }, { outcome: { status: "done" }, report: "# Report" }]);
  assert.deepEqual((await s.run({ phase: "build", token: "t", prompt: "p" })).outcome, { status: "blocked", comment: "Which one?" });
  const r = await s.run({ phase: "report", token: "t", prompt: "p" });
  assert.deepEqual(r.outcome, { status: "done", report: "# Report" });
  assert.ok(!existsSync(join(s.state, "comment.md")));
});

test("a phase that ends without outcome.json is asked once to write it", async () => {
  const s = setup([{}, { outcome: { status: "ready" } }]);
  const res = await s.run({ phase: "build", token: "t", prompt: "p" });
  assert.equal(res.outcome.status, "ready");
  const calls = s.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], /outcome\.json/);
});

test("a phase that still writes nothing fails with Claude's result subtype", async () => {
  const s = setup([{ subtype: "error_max_turns" }, { subtype: "error_max_turns" }]);
  await assert.rejects(s.run({ phase: "build", token: "t", prompt: "p" }), /build: no outcome\.json \(error_max_turns\)/);
});

test("a phase that runs past its timeout is killed", async () => {
  const s = setup([{ sleep: 10_000 }]);
  await assert.rejects(s.run({ phase: "build", token: "t", prompt: "p", timeoutMs: 300 }), /build: timed out after 0 minutes/);
});

test("streamLine turns stream-json events into short log lines", () => {
  assert.equal(streamLine({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "mix test test/a_test.exs" } }] } }), "→ Bash: mix test test/a_test.exs");
  assert.equal(streamLine({ type: "assistant", message: { content: [{ type: "text", text: "Reproduced it.\nNext I'll fix it." }] } }), "Reproduced it. Next I'll fix it.");
  assert.equal(streamLine({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "lib/a.ex" } }] } }), "→ Edit: lib/a.ex");
  assert.equal(streamLine({ type: "user", message: {} }), null);
  assert.equal(streamLine({ type: "result", subtype: "success", num_turns: 9, total_cost_usd: 2.5 }), "result: success after 9 turns, $2.50");
});

test("every stream event goes to onEvent, for the status comment", async () => {
  const events = [];
  const s = setup([{ outcome: { status: "ready" } }], { onEvent: (ev) => events.push(ev.type) });
  await s.run({ phase: "build", token: "ghs_read", prompt: "build it" });
  assert.deepEqual(events, ["assistant", "result"]);
});
