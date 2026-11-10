import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareResolve, planSweep, planComment, awaitMergeable, isStack, BACKOFF_MS } from "../lib/resolve.mjs";

const HEAD = "a".repeat(40);
const BOT = "ntodd-agent[bot]";
const NOW = Date.parse("2026-11-09T12:00:00Z");

const pull = (over = {}) => ({
  number: 9,
  state: "open",
  draft: false,
  title: "Fix it",
  body: "Fixes #7",
  author: BOT,
  createdAt: "2026-11-07T13:00:00Z",
  updatedAt: "2026-11-08T09:00:00Z",
  mergeable: "CONFLICTING",
  headSha: HEAD,
  headRef: "feature/7-fix",
  headRepo: "ntodd/sandbox",
  baseRef: "main",
  defaultBranch: "main",
  labels: [],
  editors: [],
  closes: { total: 1, more: false, issues: [{ number: 7, repo: "ntodd/sandbox" }] },
  ...over,
});
const issue = (over = {}) => ({ number: 7, state: "open", user: { login: "ntodd" }, labels: [{ name: "agent-done" }], body: "Broken", ...over });
const labeled = (label, actor, at) => ({ label, actor, at });

// GitHub as the dispatching jobs and the run read it. A pull given as an
// array is a sequence: each read takes the next state, and the last repeats.
function world({ pulls = [pull()], issues = { 7: issue() }, events = { 7: [labeled("agent-ready", "ntodd", "2026-11-07T12:00:00Z")] }, editors = {}, comments = {} } = {}) {
  let t = NOW;
  const reads = { pull: 0, openPulls: 0, issue: 0 };
  const at = (p, i) => (Array.isArray(p) ? p[Math.min(i, p.length - 1)] : p);
  const github = {
    pull: async (n) => {
      const i = reads.pull++;
      return pulls.map((p) => at(p, i)).find((p) => p.number === n) ?? null;
    },
    openPulls: async () => {
      const i = reads.openPulls++;
      return pulls.map((p) => at(p, i)).filter((p) => p.state === "open");
    },
    issue: async (n) => {
      reads.issue++;
      if (!issues[n]) throw new Error(`GET /repos/ntodd/sandbox/issues/${n}: 404 Not Found`);
      return issues[n];
    },
    editors: async (n) => editors[n] ?? [],
    labelEvents: async (n) => events[n] ?? [],
    commentById: async (id) => comments[id] ?? null,
  };
  const clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  const opts = { github, clock, repo: "ntodd/sandbox", label: "agent-ready", trustedUsers: ["ntodd"] };
  return { github, clock, opts, reads, elapsed: () => t - NOW };
}

const request = (over = {}) => ({ mode: "resolve", issue: 7, pr: 9, head: HEAD, comment: null, ...over });
const actions = { login: "github-actions[bot]" };

test("prepareResolve goes ahead on a conflicting PR that passes the checks", async () => {
  const w = world();
  const res = await prepareResolve({ ...w.opts, request: request(), sender: actions, appBot: BOT });
  assert.equal(res.go, true);
  assert.equal(res.kind, "agent");
  assert.equal(res.pr.number, 9);
  assert.equal(res.issue.number, 7);
});

test("prepareResolve refuses what the checks refuse, and says it was refused", async () => {
  const w = world({ events: {} });
  const res = await prepareResolve({ ...w.opts, request: request(), sender: actions, appBot: BOT });
  assert.deepEqual(res, { go: false, refused: true, reason: "nobody labeled #7 agent-ready" });
  const edited = world({ editors: { 7: [BOT] } });
  assert.match((await prepareResolve({ ...edited.opts, request: request(), sender: actions, appBot: BOT })).reason, /edited #7 and isn't trusted/);
  const gone = world({ issues: {} });
  assert.match((await prepareResolve({ ...gone.opts, request: request(), sender: actions, appBot: BOT })).reason, /no issue #7/);
});

test("prepareResolve stops when the head changed between the dispatch and the run", async () => {
  const w = world({ pulls: [pull({ headSha: "b".repeat(40) })] });
  const res = await prepareResolve({ ...w.opts, request: request(), sender: actions, appBot: BOT });
  assert.equal(res.go, false);
  assert.equal(res.refused, false);
  assert.match(res.reason, /#9's head moved from aaaaaaa to bbbbbbb/);
});

test("prepareResolve stops when the PR no longer conflicts", async () => {
  const w = world({ pulls: [pull({ mergeable: "MERGEABLE" })] });
  const res = await prepareResolve({ ...w.opts, request: request(), sender: actions, appBot: BOT });
  assert.deepEqual(res, { go: false, refused: false, reason: "#9 doesn't conflict with main any more" });
});

test("prepareResolve waits out UNKNOWN, and stops if GitHub never says", async () => {
  const w = world({ pulls: [[pull({ mergeable: "UNKNOWN" }), pull({ mergeable: "UNKNOWN" }), pull()]] });
  assert.equal((await prepareResolve({ ...w.opts, request: request(), sender: actions, appBot: BOT })).go, true);
  assert.equal(w.elapsed(), BACKOFF_MS[0] + BACKOFF_MS[1]);

  const never = world({ pulls: [pull({ mergeable: "UNKNOWN" })] });
  const res = await prepareResolve({ ...never.opts, request: request(), sender: actions, appBot: BOT });
  assert.match(res.reason, /GitHub didn't say whether #9 conflicts/);
  assert.equal(never.elapsed(), BACKOFF_MS.reduce((a, b) => a + b));
  assert.ok(never.elapsed() >= 3 * 60_000 && never.elapsed() <= 6 * 60_000, "a few minutes");
});

test("prepareResolve checks the PR again after the wait, since that's the read the run uses", async () => {
  const w = world({ pulls: [[pull({ mergeable: "UNKNOWN" }), pull({ baseRef: "release" })]] });
  const res = await prepareResolve({ ...w.opts, request: request(), sender: actions, appBot: BOT });
  assert.deepEqual(res, { go: false, refused: true, reason: "#9 goes into release, not main" });
});

test("the gate doesn't wait: UNKNOWN goes through for the run to settle", async () => {
  const w = world({ pulls: [pull({ mergeable: "UNKNOWN" })] });
  const res = await prepareResolve({ ...w.opts, request: request(), sender: actions, wait: false });
  assert.equal(res.go, true);
  assert.equal(w.elapsed(), 0);
});

const mine = (over = {}) => pull({ number: 12, author: "ntodd", headRef: "feature/mine", closes: { total: 0, more: false, issues: [] }, ...over });
const ownRequest = (over = {}) => request({ issue: null, pr: 12, comment: 41, ...over });
const ask = { id: 41, pr: 12, body: "/resolve", author: "ntodd" };

test("prepareResolve takes a trusted user's own PR on the strength of the /resolve comment, with no issue read", async () => {
  const w = world({ pulls: [mine()], comments: { 41: ask } });
  const res = await prepareResolve({ ...w.opts, request: ownRequest(), sender: actions, appBot: BOT });
  assert.equal(res.go, true);
  assert.equal(res.kind, "own");
  assert.equal(res.issue, null);
  assert.equal(w.reads.issue, 0);
});

test("prepareResolve refuses an own-PR dispatch whose comment is missing, elsewhere, different or untrusted", async () => {
  const run = async (comments, req = ownRequest()) => (await prepareResolve({ ...world({ pulls: [mine(), pull({ number: 13, author: "ntodd" })], comments }).opts, request: req, sender: actions, appBot: BOT })).reason;
  assert.match(await run({}), /no \/resolve comment 41/);
  assert.match(await run({ 41: { ...ask, pr: 13 } }), /comment 41 isn't on #12/);
  assert.match(await run({ 41: { ...ask, body: "/resolve now" } }), /doesn't say \/resolve/);
  assert.match(await run({ 41: { ...ask, author: "stranger" } }), /stranger wrote the \/resolve comment/);
});

test("awaitMergeable stops polling once the PR is closed", async () => {
  const w = world({ pulls: [pull({ state: "merged", mergeable: "UNKNOWN" })] });
  assert.equal((await awaitMergeable({ github: w.github, pr: 9, clock: w.clock })).state, "merged");
  assert.equal(w.elapsed(), 0);
});

test("isStack: a stack/ branch, or a branch another open PR is based on", () => {
  const top = pull({ number: 10, headRef: "feature/8-top", baseRef: "feature/7-fix" });
  assert.equal(isStack(pull(), [pull(), top]), true);
  assert.equal(isStack(pull({ headRef: "stack/7-bottom" }), []), true);
  assert.equal(isStack(pull(), [pull(), pull({ number: 11, headRef: "feature/11-other" })]), false);
});

// The sweep.

const sweep = (w, over = {}) => planSweep({ ...w.opts, appBot: BOT, timeoutMs: 360 * 60_000, ...over });
const many = (n) => {
  const pulls = [];
  const issues = {};
  const events = {};
  for (let i = 0; i < n; i++) {
    const issueNumber = 100 + i;
    const number = 200 + i;
    // The higher the number, the longer ago it was updated.
    pulls.push(pull({ number, updatedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(), closes: { total: 1, more: false, issues: [{ number: issueNumber, repo: "ntodd/sandbox" }] } }));
    issues[issueNumber] = issue({ number: issueNumber });
    events[issueNumber] = [labeled("agent-ready", "ntodd", "2026-11-07T12:00:00Z")];
  }
  return { pulls, issues, events };
};

test("the sweep dispatches a conflicting PR of the App's, with its issue and head", async () => {
  const res = await sweep(world());
  assert.deepEqual(res.picked, [{ issue: 7, pr: 9, head: HEAD }]);
  assert.deepEqual(res.skipped, []);
});

test("the sweep leaves a PR that's only behind alone", async () => {
  const w = world({ pulls: [pull({ mergeable: "MERGEABLE" })] });
  const res = await sweep(w);
  assert.deepEqual(res.picked, []);
  assert.deepEqual(res.skipped, []);
  assert.equal(w.reads.issue, 0);
});

test("the sweep retries UNKNOWN until GitHub answers", async () => {
  const w = world({ pulls: [[pull({ mergeable: "UNKNOWN" }), pull()]] });
  assert.deepEqual((await sweep(w)).picked, [{ issue: 7, pr: 9, head: HEAD }]);
  assert.equal(w.elapsed(), BACKOFF_MS[0]);
});

test("the sweep leaves a PR that stays UNKNOWN for the next sweep", async () => {
  const w = world({ pulls: [pull({ mergeable: "UNKNOWN" })] });
  const res = await sweep(w);
  assert.deepEqual(res.picked, []);
  assert.match(res.skipped[0].reason, /hasn't worked out whether it conflicts/);
  assert.equal(w.elapsed(), BACKOFF_MS.reduce((a, b) => a + b));
});

test("the sweep doesn't wait on someone else's UNKNOWN PR", async () => {
  const w = world({ pulls: [pull(), mine({ mergeable: "UNKNOWN" })] });
  await sweep(w);
  assert.equal(w.elapsed(), 0);
});

test("the sweep skips a PR labeled agent-conflict", async () => {
  const res = await sweep(world({ pulls: [pull({ labels: ["agent-conflict"] })] }));
  assert.deepEqual(res.picked, []);
  assert.match(res.skipped[0].reason, /agent-conflict/);
});

test("the sweep skips an issue a run is working, unless the agent-working label is older than the job's timeout", async () => {
  const working = { 7: issue({ labels: [{ name: "agent-working" }] }) };
  const since = (minutes) => ({ 7: [labeled("agent-ready", "ntodd", "2026-11-07T12:00:00Z"), labeled("agent-working", BOT, new Date(NOW - minutes * 60_000).toISOString())] });
  const fresh = await sweep(world({ issues: working, events: since(30) }));
  assert.deepEqual(fresh.picked, []);
  assert.match(fresh.skipped[0].reason, /#7 is labeled agent-working/);
  const stale = await sweep(world({ issues: working, events: since(361) }));
  assert.deepEqual(stale.picked, [{ issue: 7, pr: 9, head: HEAD }]);
  const shorter = await sweep(world({ issues: working, events: since(61) }), { timeoutMs: 60 * 60_000 });
  assert.equal(shorter.picked.length, 1);
});

test("the sweep skips a PR whose resolve run is already queued, and an issue whose build ended blocked", async () => {
  const queued = await sweep(world(), { active: [9] });
  assert.deepEqual(queued.picked, []);
  assert.match(queued.skipped[0].reason, /already queued or going/);
  const blocked = await sweep(world({ issues: { 7: issue({ labels: [{ name: "agent-blocked" }] }) } }));
  assert.deepEqual(blocked.picked, []);
  assert.match(blocked.skipped[0].reason, /#7 is labeled agent-blocked/);
});

test("the sweep skips stacks", async () => {
  const bottom = pull({ headRef: "stack/7-bottom" });
  const top = pull({ number: 10, headRef: "stack/7-top", baseRef: "stack/7-bottom" });
  const res = await sweep(world({ pulls: [bottom, top] }));
  assert.deepEqual(res.picked, []);
  assert.deepEqual(res.skipped.map((s) => [s.pr, /stack/.test(s.reason)]), [[9, true], [10, true]]);
  const based = await sweep(world({ pulls: [pull(), pull({ number: 10, author: "ntodd", mergeable: "MERGEABLE", headRef: "feature/on-top", baseRef: "feature/7-fix" })] }));
  assert.deepEqual(based.picked, []);
});

test("the sweep never touches a PR a trusted user wrote, or a stranger's", async () => {
  const w = world({ pulls: [mine(), pull({ number: 13, author: "stranger" })] });
  const res = await sweep(w);
  assert.deepEqual(res.picked, []);
  assert.deepEqual(res.skipped, []);
});

test("the sweep starts at most five, the least recently updated first, and one per issue", async () => {
  const w = world(many(7));
  const res = await sweep(w);
  assert.deepEqual(res.picked.map((p) => p.pr), [206, 205, 204, 203, 202]);
  assert.deepEqual(res.skipped.map((s) => s.pr), [201, 200]);
  assert.match(res.skipped[0].reason, /5 at a time/);
  assert.equal(w.reads.issue, 5, "the ones past the cap aren't looked up");

  const twins = many(1);
  twins.pulls.push(pull({ number: 300, updatedAt: new Date(NOW).toISOString(), closes: twins.pulls[0].closes }));
  const one = await sweep(world(twins));
  assert.deepEqual(one.picked.map((p) => p.pr), [200]);
  assert.match(one.skipped[0].reason, /another pull request for #100/);
});

test("the sweep applies the resolve checks: no label, an untrusted label, an edited issue, a PR older than the label, a cross-repo reference", async () => {
  const reason = async (w) => {
    const res = await sweep(world(w));
    assert.deepEqual(res.picked, []);
    return res.skipped[0].reason;
  };
  assert.match(await reason({ events: {} }), /nobody labeled #7/);
  assert.match(await reason({ events: { 7: [labeled("agent-ready", BOT, "2026-11-07T12:00:00Z")] } }), /last labeled #7 agent-ready and isn't trusted/);
  assert.match(await reason({ editors: { 7: ["stranger"] } }), /stranger edited #7/);
  assert.match(await reason({ pulls: [pull({ createdAt: "2026-11-07T11:00:00Z" })] }), /opened before/);
  assert.match(await reason({ pulls: [pull({ closes: { total: 1, more: false, issues: [{ number: 7, repo: "other/repo" }] } })] }), /another repo/);
  assert.match(await reason({ pulls: [pull({ headRepo: "stranger/sandbox" })] }), /branch is in stranger\/sandbox/);
});

// The /resolve comment.

const commentEvent = (over = {}) => ({
  action: "created",
  sender: { login: "ntodd" },
  issue: { number: 9, pull_request: {} },
  comment: { id: 41, body: "/resolve", user: { login: "ntodd" } },
  ...over,
});
const onComment = (w, event) => planComment({ ...w.opts, appBot: BOT, event });

test("/resolve on the App's conflicting PR dispatches a resolve for its issue", async () => {
  const res = await onComment(world(), commentEvent());
  assert.deepEqual(res, { inputs: { issue: "7", mode: "resolve", pr: "9", head: HEAD } });
});

test("/resolve on a trusted user's own PR dispatches with the comment and no issue", async () => {
  const w = world({ pulls: [mine()], comments: { 41: ask } });
  const res = await onComment(w, commentEvent({ issue: { number: 12, pull_request: {} } }));
  assert.deepEqual(res, { inputs: { mode: "resolve", pr: "12", head: HEAD, comment: "41" } });
});

test("/resolve does nothing when a resolve run on the PR is already queued", async () => {
  const res = await planComment({ ...world().opts, appBot: BOT, event: commentEvent(), active: [9] });
  assert.deepEqual(res, { reason: "a resolve run on #9 is already queued or going" });
});

test("/resolve does nothing on a PR that's already fine", async () => {
  const res = await onComment(world({ pulls: [pull({ mergeable: "MERGEABLE" })] }), commentEvent());
  assert.deepEqual(res, { reason: "#9 doesn't conflict with main any more" });
});

test("/resolve from an untrusted user, or with extra text, or on an issue, does nothing", async () => {
  const none = async (event) => {
    const w = world();
    const res = await onComment(w, event);
    assert.equal(res.inputs, undefined);
    assert.equal(w.reads.pull, 0, "refused from the payload alone");
    return res.reason;
  };
  assert.match(await none(commentEvent({ sender: { login: "stranger" } })), /stranger commented and isn't trusted/);
  assert.match(await none(commentEvent({ comment: { id: 41, body: "/resolve", user: { login: "stranger" } } })), /stranger wrote the comment and isn't trusted/);
  assert.match(await none(commentEvent({ comment: { id: 41, body: "/resolve this please", user: { login: "ntodd" } } })), /isn't exactly \/resolve/);
  assert.match(await none(commentEvent({ issue: { number: 9 } })), /isn't a pull request/);
  assert.match(await none(commentEvent({ action: "edited" })), /isn't a new comment/);
});

test("/resolve on a PR someone untrusted wrote, on a fork's PR, or on one into another branch does nothing", async () => {
  const reason = async (pulls, n = 12) => (await onComment(world({ pulls, comments: { 41: ask } }), commentEvent({ issue: { number: n, pull_request: {} } }))).reason;
  assert.match(await reason([mine({ author: "stranger" })]), /stranger opened #12/);
  assert.match(await reason([mine({ headRepo: "ntodd/fork" })]), /#12's branch is in ntodd\/fork/);
  assert.match(await reason([mine({ baseRef: "release" })]), /#12 goes into release, not main/);
  assert.match(await reason([], 12), /no pull request #12/);
});

test("/resolve on the App's PR still needs the issue to pass: an unlabeled issue or an ambiguous reference does nothing", async () => {
  assert.match((await onComment(world({ events: {} }), commentEvent())).reason, /nobody labeled #7/);
  const two = pull({ closes: { total: 2, more: false, issues: [{ number: 7, repo: "ntodd/sandbox" }, { number: 8, repo: "ntodd/sandbox" }] } });
  assert.match((await onComment(world({ pulls: [two] }), commentEvent())).reason, /closes 2 issues/);
});
