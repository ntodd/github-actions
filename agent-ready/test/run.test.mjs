import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../lib/run.mjs";
import { BACKOFF_MS } from "../lib/resolve.mjs";

// A fake world: a scripted Claude, GitHub read state that changes as the
// clock moves, and a writer that records what it did.
function world({ outcomes, prs = {}, threads = {}, bots = [], rerun, author = "ntodd", resolve = null, issue = null, mergeable = () => "MERGEABLE", base = () => "base1", ...config } = {}) {
  let t = Date.parse("2026-11-07T12:00:00Z");
  const log = { phases: [], tokens: [], writes: [], minted: 0, attached: [], steps: [], finished: null };
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
    // What a resolve run reads: whether the PR merges, and the base's tip.
    pull: async (n) => {
      const p = typeof prs[n] === "function" ? prs[n](t) : prs[n];
      return { ...p, mergeable: mergeable(p.headSha, t), baseRef: "main" };
    },
    branchSha: async (ref) => base(ref, t),
  };
  const fail = config.fail ?? {};
  const writer = (token) => ({
    removeLabel: async (n, name) => log.writes.push(["removeLabel", token, n, name]),
    addLabels: async (n, names) => log.writes.push(["addLabels", token, n, names]),
    comment: async (n, body) => log.writes.push(["comment", token, n, body]),
    markReady: async (nodeId) => {
      if (fail.markReady) throw new Error(fail.markReady);
      log.writes.push(["markReady", token, nodeId]);
    },
    requestReviewers: async (n, who) => {
      if (fail.requestReviewers) throw new Error(fail.requestReviewers);
      log.writes.push(["requestReviewers", token, n, who]);
    },
  });
  const progress = {
    step: async (label) => log.steps.push(label),
    note: async () => {},
    finish: async (text) => (log.finished = text),
  };
  const mint = async () => `app-${++log.minted}`;
  const run = () =>
    runAgent({
      repo: "ntodd/sandbox",
      issue: issue ?? { number: 7, title: "Fix it", body: "Broken", comments: [], author },
      resolve,
      config: {
        label: "agent-ready",
        trustedUsers: ["ntodd"],
        bots,
        maxRounds: 2,
        readyForBots: false,
        checksGraceMs: 120_000,
        reviewTimeoutMs: 600_000,
        pollMs: 30_000,
        runUrl: "https://run",
        ...config,
      },
      readToken: "read",
      github,
      mint,
      writer,
      claude,
      attach: async (n) => log.attached.push(n),
      rerun,
      progress,
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
    ["removeLabel", "app-1", 7, "agent-done"],
    ["removeLabel", "app-1", 7, "agent-blocked"],
    ["addLabels", "app-1", 7, ["agent-working"]],
    ["markReady", "app-3", "PR_5"],
    ["requestReviewers", "app-3", 5, ["ntodd"]],
    ["removeLabel", "app-3", 7, "agent-working"],
    ["addLabels", "app-3", 7, ["agent-done"]],
  ]);
  assert.deepEqual(w.log.steps, ["Build: triage, reproduce, TDD and review", "Open the draft PRs", "Wait for CI on #5", "Write the report"]);
  assert.equal(w.log.finished, "**agent-ready is done.** #5 is ready for review.");
});

test("when it's done, the reviewers it's given are asked, and a PR that's already ready is left alone", async () => {
  const w = world({
    reviewers: ["ntodd", "acme/web"],
    outcomes: [{ status: "ready" }, { status: "published", prs: [5, 6] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1", { draft: false }), 6: pr("b1", { number: 6, nodeId: "PR_6" }), checksFor: () => green },
  });
  await w.run();
  assert.deepEqual(w.log.writes.filter(([op]) => op === "markReady" || op === "requestReviewers"), [
    ["requestReviewers", "app-3", 5, ["ntodd", "acme/web"]],
    ["markReady", "app-3", "PR_6"],
    ["requestReviewers", "app-3", 6, ["ntodd", "acme/web"]],
  ]);
  assert.equal(w.log.finished, "**agent-ready is done.** #5 and #6 are ready for review.");
});

test("on an issue a bot wrote, like flake-hunt's, the owner is asked to review", async () => {
  const w = world({
    author: "github-actions[bot]",
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => green },
  });
  await w.run();
  assert.deepEqual(w.log.writes.find(([op]) => op === "requestReviewers"), ["requestReviewers", "app-3", 5, ["ntodd"]]);
});

test("a run that needs a decision comments on the issue and labels it blocked", async () => {
  const w = world({ outcomes: [{ status: "blocked", comment: "Which default do you want?" }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.deepEqual(w.log.phases, ["build"]);
  assert.deepEqual(w.log.writes.slice(4), [
    ["comment", "app-2", 7, "**Blocked:** The build stopped before opening a pull request.\n\nWhich default do you want?\n\n[Run log](https://run)"],
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
  const [, , , body] = w.log.writes.find(([op]) => op === "comment");
  assert.equal(body, "**Blocked:** CI or review is still open after 2 rounds: #5 test (failure).\n\nPull requests: #5. [Run log](https://run)");
  assert.ok(!w.log.writes.some(([op]) => op === "markReady" || op === "requestReviewers"), "a blocked run leaves the drafts alone");
  assert.match(w.log.finished, /^\*\*agent-ready is blocked\.\*\* CI or review is still open/);
});

const flaky = (job) => ({
  checkRuns: [
    { name: "test", status: "completed", conclusion: "failure", html_url: job ? `https://github.com/o/r/actions/runs/1/job/${job}` : "https://ci/1" },
    ...(job ? [{ name: "e2e", status: "completed", conclusion: "cancelled", html_url: `https://github.com/o/r/actions/runs/1/job/${job + 1}` }] : []),
  ],
  statuses: [],
});

test("a flake gets its failed jobs rerun, not a block", async () => {
  const reruns = [];
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "nothing-to-do", comment: "It's the lock race; it passes locally." }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => (reruns.length ? green : flaky(22)) },
    rerun: async (jobs) => reruns.push(...jobs),
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.equal(res.rounds, 1);
  assert.deepEqual(reruns, [1], "one rerun of the failed jobs per workflow run");
  assert.deepEqual(w.log.phases, ["build", "publish", "respond", "report"]);
  assert.ok(w.log.steps.includes("Rerun the flaky jobs: #5 test, #5 e2e"));
  assert.ok(!w.log.writes.some(([op]) => op === "comment"), "nothing to say on the issue when the rerun passes");
});

test("nothing to change but nothing to rerun either ends blocked, naming what's still failing", async () => {
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "nothing-to-do", comment: "External CI is down." }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => flaky() },
    rerun: async () => {},
  });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "nothing in the pull requests needs to change, but these are still open: #5 test (failure)");
  const [, , , body] = w.log.writes.find(([op]) => op === "comment");
  assert.match(body, /External CI is down\./);
});

test("a rerun that's refused ends blocked with the error", async () => {
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "nothing-to-do" }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => flaky(22) },
    rerun: async () => {
      throw new Error("403 Resource not accessible by integration");
    },
  });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.match(res.reason, /^couldn't rerun #5 test, #5 e2e: 403 Resource not accessible/);
});

test("a merged PR drops out of the wait, and the rest still have to go green", async () => {
  let sha = "a1";
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5, 6] }, { status: "ready" }, { status: "published", prs: [5, 6], onRun: () => (sha = "b2") }, { status: "done", report: "ok" }],
    prs: { 5: pr("m1", { state: "merged" }), 6: () => pr(sha, { number: 6, nodeId: "PR_6" }), checksFor: (s) => (s === "a1" ? red : green) },
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.equal(res.rounds, 1, "#6's red CI still got a round");
  assert.deepEqual(w.log.writes.filter(([op]) => op === "markReady"), [["markReady", "app-4", "PR_6"]]);
});

test("a PR closed without merging stops the run, blocked", async () => {
  const w = world({
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1", { state: "closed" }), checksFor: () => running },
  });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "#5 was closed without merging");
});

test("a handover that fails is said on the issue, not swallowed", async () => {
  const w = world({
    fail: { requestReviewers: "422 Reviews may only be requested from collaborators" },
    outcomes: [{ status: "ready" }, { status: "published", prs: [5] }, { status: "done", report: "ok" }],
    prs: { 5: pr("a1"), checksFor: () => green },
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  const [, , , body] = w.log.writes.find(([op]) => op === "comment");
  assert.match(body, /couldn't ask ntodd to review #5: 422 Reviews may only be requested from collaborators/);
  assert.match(w.log.finished, /#5 is ready for review\. Asking for the review failed; the next comment says why\./);
});

test("a blocked outcome's own reason leads the comment", async () => {
  const w = world({ outcomes: [{ status: "blocked", reason: "Should the presets replace the field or sit next to it?", comment: "Details." }] });
  const res = await w.run();
  assert.equal(res.reason, "Should the presets replace the field or sit next to it?");
  const [, , , body] = w.log.writes.find(([op]) => op === "comment");
  assert.match(body, /^\*\*Blocked:\*\* Should the presets replace the field or sit next to it\?\n\nDetails\./);
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

// Resolve runs: the PR exists and conflicts with main.

const HEAD = "a".repeat(40);
const theirs = { pr: 5, own: false, stack: false, headRef: "feature/7-fix", baseRef: "main", headSha: HEAD };
const labels = (w) => w.log.writes.filter(([op]) => op === "addLabels" || op === "removeLabel").map(([op, , n, l]) => `${op === "addLabels" ? "+" : "-"}${[l].flat().join()}@${n}`);
const comments = (w, n) => w.log.writes.filter(([op, , on]) => op === "comment" && on === n).map(([, , , body]) => body);

// A resolve world: the publish after each resolve moves the PR's head.
function resolving({ outcomes, checks = () => green, ...rest }) {
  let sha = HEAD;
  let pushes = 0;
  const scripted = outcomes.map((o) => (o.status === "published" && o.push !== false ? { ...o, onRun: () => (sha = `pushed${++pushes}`) } : o));
  return world({ resolve: theirs, outcomes: scripted, prs: { 5: () => pr(sha, { draft: false }), checksFor: checks }, ...rest });
}

test("a resolve run merges, pushes the PR's branch, waits for green, checks it's mergeable and hands the PR back", async () => {
  const prompts = [];
  const w = resolving({
    outcomes: [
      { status: "ready", files: ["lib/tip.ex", "mix.lock"], onRun: ({ prompt }) => prompts.push(prompt) },
      { status: "published", prs: [99] },
      { status: "done", report: "Resolved." },
    ],
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.deepEqual(res.prs, [5], "a PR number Claude reports is ignored");
  assert.deepEqual(w.log.phases, ["resolve", "publish", "report"]);
  assert.deepEqual(w.log.tokens, ["read", "app-2", "read"], "Claude writes only in the publish phase");
  assert.deepEqual(labels(w), ["-agent-done@7", "-agent-blocked@7", "-agent-conflict@5", "+agent-working@7", "-agent-working@7", "+agent-done@7"]);
  assert.ok(!labels(w).includes("-agent-ready@7"), "the label that starts builds is left alone");
  assert.deepEqual(comments(w, 5), ["Merged `main` (base1) into this branch, because `main` had moved and the two conflicted. Conflicts resolved in `lib/tip.ex`, `mix.lock`."]);
  assert.deepEqual(w.log.writes.filter(([op]) => op === "requestReviewers"), [["requestReviewers", "app-4", 5, ["ntodd"]]]);
  assert.match(prompts[0], /"baseSha":"base1"/);
  assert.match(prompts[0], new RegExp(`"headSha":"${HEAD}"`));
  assert.deepEqual(w.log.steps, ["Merge main into #5 and resolve the conflicts", "Push the merge to #5", "Wait for CI on #5", "Write the report"]);
  assert.equal(w.log.finished, "**agent-ready is done.** #5 is ready for review.");
});

test("a resolve run blocked on a real conflict says why on the issue and marks the PR agent-conflict", async () => {
  const w = resolving({ outcomes: [{ status: "blocked", reason: "main rewrote Tip.split/2, which this PR also changes", comment: "lib/tip.ex: which behaviour do you want?" }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.deepEqual(w.log.phases, ["resolve"]);
  assert.deepEqual(comments(w, 7), ["**Blocked:** Main rewrote Tip.split/2, which this PR also changes.\n\nlib/tip.ex: which behaviour do you want?\n\nPull requests: #5. [Run log](https://run)"]);
  assert.deepEqual(labels(w).slice(4), ["-agent-working@7", "+agent-blocked@7", "+agent-conflict@5"]);
  assert.ok(!w.log.writes.some(([op]) => op === "markReady" || op === "requestReviewers"));
});

test("a resolve run where main already does what the PR does ends blocked, never done", async () => {
  const asked = resolving({ outcomes: [{ status: "blocked", reason: "main already has this change (#31), so #5 can be closed" }] });
  assert.equal((await asked.run()).status, "blocked");
  assert.match(asked.log.finished, /^\*\*agent-ready is blocked\.\*\* Main already has this change/);

  const w = resolving({ outcomes: [{ status: "nothing-to-do", comment: "main already has it" }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, 'the resolve phase ended with status "nothing-to-do"');
  assert.ok(labels(w).includes("+agent-conflict@5"));
  assert.ok(!w.log.writes.some(([op]) => op === "requestReviewers"), "a PR that should be closed isn't handed over for review");
});

test("a refused push ends blocked with GitHub's message, and the PR stays agent-conflict", async () => {
  const refusal = "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission";
  const w = resolving({ outcomes: [{ status: "ready", files: ["a.ex"] }, { status: "blocked", reason: refusal, push: false }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, refusal);
  assert.deepEqual(comments(w, 5), [], "nothing was merged, so nothing says it was");
  assert.ok(labels(w).includes("+agent-conflict@5"));
});

test("a publish that reports a push the PR never got ends blocked", async () => {
  const w = resolving({ outcomes: [{ status: "ready", files: ["a.ex"] }, { status: "published", push: false }] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.match(res.reason, /#5's head is still aaaaaaa/);
  assert.deepEqual(comments(w, 5), []);
});

test("a PR that conflicts again at the end is resolved again, as a round", async () => {
  const prompts = [];
  const w = resolving({
    outcomes: [
      { status: "ready", files: ["a.ex"] },
      { status: "published" },
      { status: "ready", files: ["b.ex"], onRun: ({ prompt }) => prompts.push(prompt) },
      { status: "published" },
      { status: "done", report: "Twice." },
    ],
    mergeable: (sha) => (sha === "pushed1" ? "CONFLICTING" : "MERGEABLE"),
    base: () => (w.log.phases.length > 1 ? "base2" : "base1"),
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.equal(res.rounds, 1);
  assert.deepEqual(w.log.phases, ["resolve", "publish", "resolve", "publish", "report"]);
  assert.match(prompts[0], /"round":1/);
  assert.match(prompts[0], /"headSha":"pushed1"/);
  assert.match(prompts[0], /"baseSha":"base2"/);
  assert.equal(comments(w, 5).length, 2);
  assert.match(comments(w, 5)[1], /\(base2\).*`b\.ex`/);
  assert.ok(w.log.steps.includes("Resolve #5 again: main moved (round 1)"));
});

test("a PR that keeps conflicting runs out of rounds and ends blocked, agent-conflict", async () => {
  const w = resolving({
    maxRounds: 1,
    outcomes: [{ status: "ready" }, { status: "published" }, { status: "ready" }, { status: "published" }, { status: "done", report: "Still conflicting." }],
    mergeable: () => "CONFLICTING",
  });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "#5 conflicts with main again, and the run is out of rounds (1)");
  assert.deepEqual(labels(w).slice(4), ["-agent-working@7", "+agent-blocked@7", "+agent-conflict@5"]);
});

test("UNKNOWN at the end is retried for a few minutes, then ends blocked without calling it a conflict", async () => {
  const w = resolving({ outcomes: [{ status: "ready" }, { status: "published" }, { status: "done", report: "?" }], mergeable: () => "UNKNOWN" });
  const t0 = w.now();
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.equal(res.reason, "GitHub never worked out whether #5 can be merged");
  assert.ok(w.now() - t0 >= BACKOFF_MS.reduce((a, b) => a + b));
  assert.ok(!labels(w).includes("+agent-conflict@5"), "the merge was pushed, so the sweep may look again");

  let asked = 0;
  const later = resolving({ outcomes: [{ status: "ready" }, { status: "published" }, { status: "done", report: "ok" }], mergeable: () => (++asked < 3 ? "UNKNOWN" : "MERGEABLE") });
  assert.equal((await later.run()).status, "done");
});

test("a resolve run still gets respond rounds for what the merge broke in CI", async () => {
  const w = resolving({
    outcomes: [{ status: "ready" }, { status: "published" }, { status: "ready" }, { status: "published" }, { status: "done", report: "ok" }],
    checks: (sha) => (sha === "pushed1" ? red : green),
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.deepEqual(w.log.phases, ["resolve", "publish", "respond", "publish", "report"]);
  assert.equal(comments(w, 5).length, 1, "only a merge gets the merge comment");
  assert.ok(w.log.steps.includes("Push round 1's changes to #5"));
});

test("a resolve run on a stack's PR ends blocked without starting Claude", async () => {
  const w = resolving({ resolve: { ...theirs, stack: true }, outcomes: [] });
  const res = await w.run();
  assert.equal(res.status, "blocked");
  assert.match(res.reason, /#5 is part of a stack/);
  assert.deepEqual(w.log.phases, []);
  assert.ok(labels(w).includes("+agent-conflict@5"));
});

const mineIssue = { number: 12, title: "Tidy the totals", body: "Splits the total.", comments: [], author: "ntodd" };
const mine = { pr: 12, own: true, stack: false, headRef: "feature/mine", baseRef: "main", headSha: HEAD };

function resolvingMine({ outcomes, draft = true, checks = () => green, ...rest }) {
  let sha = HEAD;
  let pushes = 0;
  const scripted = outcomes.map((o) => (o.status === "published" ? { ...o, onRun: () => (sha = `pushed${++pushes}`) } : o));
  return world({
    resolve: mine,
    issue: mineIssue,
    outcomes: scripted,
    prs: { 12: () => pr(sha, { number: 12, nodeId: "PR_12", draft }), checksFor: checks },
    ...rest,
  });
}

test("/resolve on a trusted user's own PR resolves it and reports on the PR, with no handover", async () => {
  const w = resolvingMine({
    readyForBots: true,
    bots: ["coderabbitai[bot]"],
    outcomes: [{ status: "ready", files: ["lib/total.ex"] }, { status: "published" }, { status: "done", report: "ok" }],
    // An open thread of the owner's, and a bot that never reviews.
    threads: { 12: [{ id: "T1", isResolved: false, comments: { nodes: [{ author: { login: "ntodd" }, body: "Rename this?" }] } }] },
  });
  const res = await w.run();
  assert.equal(res.status, "done");
  assert.deepEqual(w.log.phases, ["resolve", "publish", "report"], "the review threads go unanswered");
  assert.deepEqual(labels(w), ["-agent-done@12", "-agent-blocked@12", "-agent-conflict@12", "+agent-working@12", "-agent-working@12", "+agent-done@12"]);
  assert.deepEqual(comments(w, 12), [
    "Merged `main` (base1) into this branch, because `main` had moved and the two conflicted. Conflicts resolved in `lib/total.ex`. The merge commit is on `feature/mine` now, so pull before you push again.",
  ]);
  assert.ok(!w.log.writes.some(([op]) => op === "markReady" || op === "requestReviewers"), "the draft state and the reviewers are unchanged");
  assert.deepEqual(w.log.attached, [], "the description isn't touched");
  assert.equal(w.log.finished, "**agent-ready is done.** #12 merges into `main` again, and CI is green.");
  assert.ok(w.log.steps.includes("Wait for CI on #12"), "it doesn't wait for review bots");
});

test("a blocked resolve on an own PR labels the PR agent-conflict while it still conflicts, and agent-blocked once the merge is pushed", async () => {
  const stuck = resolvingMine({ outcomes: [{ status: "blocked", reason: "which of the two totals did you mean?" }] });
  await stuck.run();
  assert.deepEqual(labels(stuck).slice(4), ["-agent-working@12", "+agent-conflict@12"]);
  assert.deepEqual(comments(stuck, 12), ["**Blocked:** Which of the two totals did you mean?\n\n[Run log](https://run)"]);

  const pushed = resolvingMine({ maxRounds: 0, checks: () => red, outcomes: [{ status: "ready" }, { status: "published" }, { status: "done", report: "red" }] });
  const res = await pushed.run();
  assert.equal(res.status, "blocked");
  assert.deepEqual(labels(pushed).slice(4), ["-agent-working@12", "+agent-blocked@12"]);
});

test("a run that blocks after pushing the merge still marks the PR agent-conflict if main has moved again", async () => {
  const w = resolving({ maxRounds: 0, checks: () => red, mergeable: () => "CONFLICTING", outcomes: [{ status: "ready" }, { status: "published" }, { status: "done", report: "red" }] });
  assert.equal((await w.run()).status, "blocked");
  assert.deepEqual(labels(w).slice(4), ["-agent-working@7", "+agent-blocked@7", "+agent-conflict@5"]);
});
