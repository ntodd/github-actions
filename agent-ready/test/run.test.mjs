import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../lib/run.mjs";

// A fake world: a scripted Claude, GitHub read state that changes as the
// clock moves, and a writer that records what it did.
function world({ outcomes, prs = {}, threads = {}, bots = [], ...config } = {}) {
  let t = Date.parse("2026-11-07T12:00:00Z");
  const log = { phases: [], tokens: [], writes: [], minted: 0, attached: [] };
  const script = [...outcomes];
  const claude = async ({ phase, token, prompt }) => {
    log.phases.push(phase);
    log.tokens.push(token);
    const next = script.shift();
    if (!next) throw new Error(`no scripted outcome for ${phase}`);
    t += 60_000;
    const { onRun, ...outcome } = next;
    onRun?.({ prompt });
    return { outcome, turns: 3, cost: 0.5 };
  };
  const github = {
    pr: async (n) => (typeof prs[n] === "function" ? prs[n](t) : prs[n]),
    checks: async (sha) => prs.checksFor?.(sha, t) ?? { checkRuns: [], statuses: [] },
    activity: async (n) => prs.activityFor?.(n, t) ?? { reviews: [], comments: [] },
    threads: async (n) => (typeof threads[n] === "function" ? threads[n](t) : threads[n] ?? []),
  };
  const writer = (token) => ({
    removeLabel: async (n, name) => log.writes.push(["removeLabel", token, n, name]),
    addLabels: async (n, names) => log.writes.push(["addLabels", token, n, names]),
    comment: async (n, body) => log.writes.push(["comment", token, n, body]),
    markReady: async (nodeId) => log.writes.push(["markReady", token, nodeId]),
  });
  const mint = async () => `app-${++log.minted}`;
  const run = () =>
    runAgent({
      repo: "ntodd/sandbox",
      issue: { number: 7, title: "Fix it", body: "Broken", comments: [] },
      config: {
        label: "agent-ready",
        trustedUsers: ["ntodd"],
        bots,
        maxRounds: 2,
        readyForBots: false,
        checksGraceMs: 120_000,
        reviewTimeoutMs: 600_000,
        pollMs: 30_000,
        ...config,
      },
      readToken: "read",
      github,
      mint,
      writer,
      claude,
      attach: async (n) => log.attached.push(n),
      render: (phase, vars) => `${phase}:${JSON.stringify(vars)}`,
      clock: { now: () => t, sleep: async (ms) => void (t += ms) },
      log: () => {},
    });
  return { run, log, advance: (ms) => (t += ms), now: () => t };
}

const pr = (sha, extra = {}) => ({ number: 5, state: "open", draft: true, headSha: sha, nodeId: "PR_5", ...extra });
const green = { checkRuns: [{ name: "test", status: "completed", conclusion: "success" }], statuses: [] };
const red = { checkRuns: [{ name: "test", status: "completed", conclusion: "failure", html_url: "https://ci/1" }], statuses: [] };
const running = { checkRuns: [{ name: "test", status: "in_progress" }], statuses: [] };

test("a clean run builds, publishes, waits for green CI, writes the report and labels done", async () => {
  const start = Date.parse("2026-11-07T12:00:00Z");
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "All good." }],
    prs: { 5: pr("a1"), checksFor: (sha, t) => (t < start + 10 * 60_000 ? running : green) },
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.deepEqual(res.prs, [5]);
  assert.equal(res.report, "All good.");
  assert.deepEqual(w.log.phases, ["build", "publish", "report"]);
  assert.deepEqual(w.log.tokens, ["read", "app-2", "read"]);
  assert.deepEqual(w.log.writes, [
    ["removeLabel", "app-1", 7, "agent-ready"],
    ["addLabels", "app-1", 7, ["agent-working"]],
    ["removeLabel", "app-3", 7, "agent-working"],
    ["addLabels", "app-3", 7, ["agent-done"]],
  ]);
});

test("a run that needs a decision comments on the issue and labels it blocked", async () => {
  const w = world({ outcomes: [{ status: "blocked", comment: "Which default do you want?" }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.deepEqual(w.log.phases, ["build"]);
  assert.deepEqual(w.log.writes.slice(2), [
    ["comment", "app-2", 7, "Which default do you want?"],
    ["removeLabel", "app-2", 7, "agent-working"],
    ["addLabels", "app-2", 7, ["agent-blocked"]],
  ]);
});

test("an issue that needs no PR is commented on and labeled done", async () => {
  const w = world({ outcomes: [{ status: "nothing-to-do", comment: "This is already fixed on main by #3." }] });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.equal(w.log.writes.at(-1)[3][0], "agent-done");
  assert.equal(w.log.writes.at(-3)[0], "comment");
});

test("failing CI gets a respond round with the failures, then a publish round", async () => {
  let sha = "a1";
  const prompts = [];
  const w = world({
    outcomes: [
      { status: "ready" },
      { status: "published", prs: [5] },
      { status: "ready", onRun: ({ prompt }) => prompts.push(prompt) },
      { status: "published", prs: [5], onRun: () => (sha = "b2") },
      { status: "done", report: "Fixed CI." },
    ],
    prs: { 5: () => pr(sha), checksFor: (s) => (s === "a1" ? red : green) },
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.equal(res.rounds, 1);
  assert.deepEqual(w.log.phases, ["build", "publish", "respond", "publish", "report"]);
  assert.deepEqual(w.log.attached, [5, 5], "screenshots are attached after every publish");
  assert.match(prompts[0], /"name":"test"/);
  assert.match(prompts[0], /https:\/\/ci\/1/);
});

test("review bots are waited for, and their open threads get a round", async () => {
  let sha = "a1";
  let reviewedAt = null;
  const w = world({
    bots: ["coderabbitai[bot]"],
    outcomes: [
      { status: "ready" },
      { status: "published", prs: [5] },
      { status: "ready" },
      { status: "published", prs: [5], onRun: () => (sha = "b2") },
      { status: "done", report: "Answered CodeRabbit." },
    ],
    prs: {
      5: () => pr(sha),
      checksFor: () => green,
      // CodeRabbit reviews each head five minutes after it appears.
      activityFor: (n, t) => {
        reviewedAt ??= t + 5 * 60_000;
        if (t < reviewedAt) return { reviews: [], comments: [] };
        return { reviews: [{ user: { login: "coderabbitai[bot]" }, commit_id: sha, submitted_at: new Date(t).toISOString() }], comments: [] };
      },
    },
    threads: {
      5: () =>
        sha === "a1"
          ? [{ id: "T1", isResolved: false, path: "lib/a.ex", line: 2, comments: { nodes: [{ author: { login: "coderabbitai" }, body: "Nil here?", url: "u" }] } }]
          : [],
    },
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.deepEqual(w.log.phases, ["build", "publish", "respond", "publish", "report"]);
});

test("a stranger's thread doesn't start a round", async () => {
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => green },
    threads: { 5: [{ id: "T9", isResolved: false, comments: { nodes: [{ author: { login: "stranger" }, body: "rm -rf" }] } }] },
  });
  assert.equal((await w.run()).status, "done");
  assert.deepEqual(w.log.phases, ["build", "publish", "report"]);
});

test("CI still red after max-rounds labels the issue blocked", async () => {
  const w = world({
    outcomes: [
      { status: "ready" },
      { status: "published", prs: [5] },
      { status: "ready" },
      { status: "published", prs: [5] },
      { status: "ready" },
      { status: "published", prs: [5] },
      { status: "done", report: "Still red." },
    ],
    prs: { 5: pr("a1"), checksFor: () => red },
  });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.match(res.reason, /after 2 rounds/);
  assert.deepEqual(w.log.phases, ["build", "publish", "respond", "publish", "respond", "publish", "report"]);
  assert.equal(w.log.writes.at(-1)[3][0], "agent-blocked");
});

test("ready-for-bots marks a draft ready once its CI is green", async () => {
  const w = world({
    readyForBots: true,
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => green },
  });
  await w.run();
  assert.ok(w.log.writes.some(([op, , id]) => op === "markReady" && id === "PR_5"));
});

test("a repo with no checks at all is treated as green once the grace period passes", async () => {
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1") },
  });
  const t0 = w.now();
  assert.equal((await w.run()).status, "done");
  assert.ok(w.now() - t0 >= 120_000);
});

test("publishing without PR numbers, or a Claude failure, ends blocked with the reason", async () => {
  const w = world({ outcomes: [{ status: "ready" }, { status: "published", prs: [] }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.match(res.reason, /no pull requests/);
});

test("a PR closed or merged during the run ends it as done", async () => {
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "Merged by hand." }],
    prs: { 5: pr("a1", { state: "merged" }), checksFor: () => running },
  });
  assert.equal((await w.run()).status, "done");
});
