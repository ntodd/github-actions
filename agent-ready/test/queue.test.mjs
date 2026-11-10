import { test } from "node:test";
import assert from "node:assert/strict";
import { aheadOf, awaitTurn, MAX_WAIT_MS, POLL_MS } from "../lib/queue.mjs";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const flaky = (number, labels) => ({
  number,
  state: "open",
  user: { login: "github-actions[bot]" },
  labels: labels.map((name) => ({ name })),
  body: `Failed 2 of 96 runs.\n\n<!-- flake-hunt:%3A%3ADemo.Test%3A%3Atest%20${number} -->\n`,
});
const closing = (pr, issues, repo = "ntodd/sandbox") => ({ number: pr, closes: { total: issues.length, more: false, issues: issues.map((number) => ({ number, repo })) } });

// GitHub as the gate reads it. issues and pulls may be functions of the
// clock, for a queue that moves while a run waits.
function world({ issues = [], pulls = [], events = {} } = {}) {
  let t = NOW;
  const at = (v) => (typeof v === "function" ? v(t) : v);
  const github = {
    labeledIssues: async (label) => at(issues).filter((i) => i.labels.some((l) => l.name === label)),
    openPulls: async () => at(pulls),
    labelEvents: async (n) => events[n] ?? [],
  };
  const clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  return { github, clock, elapsed: () => t - NOW };
}
const opts = { issue: 20, label: "agent-ready", repo: "ntodd/sandbox", staleMs: 360 * 60_000 };
const labeledAt = (label, minutes) => [{ label, actor: "github-actions[bot]", at: ago(minutes) }];

test("a run is ahead when its flake-hunt issue is queued with a lower number, or working with no pull request yet", async () => {
  const w = world({
    issues: [flaky(18, ["agent-ready"]), flaky(22, ["agent-ready"]), flaky(15, ["agent-working"]), flaky(16, ["agent-working"])],
    pulls: [closing(30, [16])],
    events: { 18: labeledAt("agent-ready", 1), 22: labeledAt("agent-ready", 1), 15: labeledAt("agent-working", 20), 16: labeledAt("agent-working", 20) },
  });
  assert.deepEqual(await aheadOf({ ...opts, github: w.github, now: NOW }), { queued: [18], working: [15] });
});

test("only flake-hunt's issues count, and labels older than a job can run are ignored", async () => {
  const mine = { ...flaky(10, ["agent-ready", "agent-working"]), user: { login: "ntodd" } };
  const w = world({
    issues: [mine, flaky(11, ["agent-ready"]), flaky(12, ["agent-working"])],
    events: { 10: labeledAt("agent-ready", 1), 11: labeledAt("agent-ready", 361), 12: labeledAt("agent-working", 400) },
  });
  assert.deepEqual(await aheadOf({ ...opts, github: w.github, now: NOW }), { queued: [], working: [] });
});

test("a pull request in another repo that closes the same number doesn't count", async () => {
  const w = world({ issues: [flaky(15, ["agent-working"])], pulls: [closing(30, [15], "other/repo")], events: { 15: labeledAt("agent-working", 5) } });
  assert.deepEqual((await aheadOf({ ...opts, github: w.github, now: NOW })).working, [15]);
});

test("awaitTurn goes at once when nothing is ahead", async () => {
  const w = world({ issues: [flaky(20, ["agent-ready"])], events: { 20: labeledAt("agent-ready", 1) } });
  assert.deepEqual(await awaitTurn({ ...opts, github: w.github, clock: w.clock, log: () => {} }), { waitedMs: 0, gaveUp: false });
});

test("awaitTurn waits until the run ahead opens its pull request", async () => {
  const opensAt = NOW + 25 * 60_000;
  const w = world({
    issues: [flaky(15, ["agent-working"])],
    pulls: (t) => (t >= opensAt ? [closing(30, [15])] : []),
    events: { 15: labeledAt("agent-working", 5) },
  });
  const said = [];
  const res = await awaitTurn({ ...opts, github: w.github, clock: w.clock, log: (l) => said.push(l) });
  assert.equal(res.gaveUp, false);
  assert.equal(res.waitedMs, 25 * 60_000);
  assert.equal(said.length, 1, "says why once, not every poll");
  assert.match(said[0], /#15/);
});

test("awaitTurn gives up after the longest wait and lets the run go", async () => {
  const w = world({ issues: [flaky(18, ["agent-ready"])], events: { 18: labeledAt("agent-ready", 1) } });
  const res = await awaitTurn({ ...opts, github: w.github, clock: w.clock, log: () => {} });
  assert.equal(res.gaveUp, true);
  assert.ok(w.elapsed() >= MAX_WAIT_MS && w.elapsed() < MAX_WAIT_MS + POLL_MS);
});

test("a queued label older than the longest wait is a run that never started, and doesn't count", async () => {
  const w = world({ issues: [flaky(18, ["agent-ready"])], events: { 18: labeledAt("agent-ready", MAX_WAIT_MS / 60_000 + 31) } });
  assert.deepEqual((await aheadOf({ ...opts, github: w.github, now: NOW })).queued, []);
});

test("awaitTurn keeps waiting through a failed read, and the wait still ends", async () => {
  let reads = 0;
  const w = world({ issues: [flaky(15, ["agent-working"])], events: { 15: labeledAt("agent-working", 5) } });
  const listed = w.github.labeledIssues;
  w.github.labeledIssues = async (label) => {
    if (reads++ === 0) throw new Error("GET /repos/ntodd/sandbox/issues: 502");
    return label === "agent-working" && w.clock.now() >= NOW + 2 * POLL_MS ? [] : listed(label);
  };
  const said = [];
  const res = await awaitTurn({ ...opts, github: w.github, clock: w.clock, log: (l) => said.push(l) });
  assert.equal(res.gaveUp, false);
  assert.equal(res.waitedMs, 2 * POLL_MS);
  assert.match(said[0], /502/);
});
