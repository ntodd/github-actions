import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeChecks, botsSettled, openThreads, botLogin } from "../lib/checks.mjs";

const run = (name, status, conclusion = null, extra = {}) => ({ name, status, conclusion, html_url: `https://x/${name}`, ...extra });

test("summarizeChecks is pending while any check runs or a status is pending", () => {
  const res = summarizeChecks({ checkRuns: [run("test", "completed", "success"), run("lint", "in_progress")], statuses: [] });
  assert.equal(res.state, "pending");
  assert.deepEqual(res.pending, ["lint"]);

  const st = summarizeChecks({ checkRuns: [], statuses: [{ context: "CodeRabbit", state: "pending" }] });
  assert.equal(st.state, "pending");
});

test("summarizeChecks fails on a failed run or status and lists each one", () => {
  const res = summarizeChecks({
    checkRuns: [run("test", "completed", "failure"), run("lint", "completed", "skipped"), run("e2e", "completed", "timed_out")],
    statuses: [{ context: "ci/legacy", state: "error", target_url: "https://y" }],
  });
  assert.equal(res.state, "failure");
  assert.deepEqual(res.failed.map((f) => [f.name, f.conclusion]), [
    ["test", "failure"],
    ["e2e", "timed_out"],
    ["ci/legacy", "error"],
  ]);
});

test("summarizeChecks is green on success, neutral and skipped, and 'none' with nothing reported", () => {
  const res = summarizeChecks({
    checkRuns: [run("a", "completed", "success"), run("b", "completed", "neutral"), run("c", "completed", "skipped")],
    statuses: [{ context: "d", state: "success" }],
  });
  assert.equal(res.state, "success");
  assert.equal(summarizeChecks({ checkRuns: [], statuses: [] }).state, "none");
});

test("summarizeChecks ignores the checks it's told to", () => {
  const res = summarizeChecks({ checkRuns: [run("agent / agent", "in_progress"), run("t", "completed", "success")], statuses: [], ignore: ["agent / agent"] });
  assert.equal(res.state, "success");
});

test("botLogin strips [bot] and lowercases, since REST and GraphQL disagree", () => {
  assert.equal(botLogin("coderabbitai[bot]"), "coderabbitai");
  assert.equal(botLogin("CodeRabbitAI"), "coderabbitai");
});

test("botsSettled waits for each bot to review the head commit or comment after the push", () => {
  const since = "2026-11-07T12:00:00Z";
  const reviews = [
    { user: { login: "coderabbitai[bot]" }, commit_id: "old", submitted_at: "2026-11-07T11:00:00Z" },
    { user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "head", submitted_at: "2026-11-07T12:05:00Z" },
  ];
  const res = botsSettled({ bots: ["coderabbitai[bot]", "copilot-pull-request-reviewer[bot]"], reviews, comments: [], headSha: "head", since });
  assert.deepEqual(res, { settled: false, waitingFor: ["coderabbitai"] });

  const comments = [{ user: { login: "coderabbitai[bot]" }, updated_at: "2026-11-07T12:03:00Z" }];
  assert.deepEqual(botsSettled({ bots: ["coderabbitai[bot]"], reviews, comments, headSha: "head", since }), { settled: true, waitingFor: [] });
  assert.deepEqual(botsSettled({ bots: [], reviews: [], comments: [], headSha: "head", since }), { settled: true, waitingFor: [] });
});

const thread = (author, extra = {}) => ({
  id: `T_${author}`,
  isResolved: false,
  isOutdated: false,
  path: "lib/a.ex",
  line: 3,
  comments: { nodes: [{ author: { login: author }, body: `from ${author}`, url: `https://x/${author}` }] },
  ...extra,
});

test("openThreads keeps unresolved threads started by trusted users or listed bots", () => {
  const threads = [thread("ntodd"), thread("coderabbitai"), thread("stranger"), thread("ntodd", { id: "T_done", isResolved: true })];
  const res = openThreads(threads, { trustedUsers: ["ntodd"], bots: ["coderabbitai[bot]"] });
  assert.deepEqual(res.map((t) => t.id), ["T_ntodd", "T_coderabbitai"]);
  assert.deepEqual(res[0], { id: "T_ntodd", author: "ntodd", path: "lib/a.ex", line: 3, outdated: false, url: "https://x/ntodd", body: "from ntodd" });
});

test("summarizeChecks keeps only each workflow's latest run of a check, so a superseded cancel doesn't count", () => {
  const res = summarizeChecks({
    checkRuns: [
      run("test", "completed", "success", { id: 30, workflow: 1 }),
      run("test", "completed", "cancelled", { id: 20, workflow: 1 }),
      run("test", "completed", "failure", { id: 25, workflow: 2 }),
    ],
    statuses: [],
  });
  assert.equal(res.state, "failure");
  assert.deepEqual(res.failed.map((f) => f.conclusion), ["failure"], "the other workflow's test still counts");

  const later = summarizeChecks({ checkRuns: [run("test", "completed", "success", { id: 1, workflow: 1 }), run("test", "completed", "failure", { id: 2, workflow: 1 })], statuses: [] });
  assert.equal(later.state, "failure", "a newer failure beats an older pass");
});

test("summarizeChecks gives each failed Actions check its workflow run ID, so the run's failed jobs can be rerun", () => {
  const res = summarizeChecks({
    checkRuns: [
      run("test", "completed", "failure", { html_url: "https://github.com/o/r/actions/runs/11/job/22" }),
      run("external", "completed", "failure", { html_url: "https://ci.example/build/9" }),
    ],
    statuses: [],
  });
  assert.deepEqual(res.failed.map((f) => [f.name, f.run]), [
    ["test", 11],
    ["external", undefined],
  ]);
});
