import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFacts, requiredChecks, observeItem, publishObservation } from "../lib/observe.mjs";
import { classifyText, readFeedback } from "../lib/admission.mjs";
import { threadTargets, threadEffectId } from "../lib/threads.mjs";
import { effectMarker } from "../lib/effects.mjs";
import { ingestCommands, resolveRoute } from "../lib/commands.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, claimed, operation, A, B, C, D, at } from "./fixtures.mjs";
const config = parseConfig("trusted-users: [ntodd]\nsignals:\n  - check: scan\n    blocking: false");
const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI", integration_id: 1 }] } }];
const check = (extra = {}) => ({ id: 1, name: "CI", app: { id: 1 }, head_sha: B, started_at: at, status: "completed", conclusion: "success", ...extra });
const raw = (sha, checks = []) => ({ sha, checkRuns: checks, statuses: [] });

test("a human review cannot satisfy a configured App review gate", async () => {
  const f = fixture();
  f.context.config = { ...config, reviewBots: ["reviewer[bot]"] };
  f.api.fileAt = async () => ({ content: "trusted-users: [ntodd]\nreview-bots: ['reviewer[bot]']" });
  f.api.reviews = async (n) => n === 9 ? [{ id: 9, body: "looks fine", author: "reviewer", state: "APPROVED", commit_id: B, lastEditedAt: null, created_at: at }] : [];
  assert.ok((await f.observe()).prs[0].signals.pending.includes("review:reviewer[bot]"));
  f.api.reviews = async (n) => n === 9 ? [{ id: 9, body: "looks fine", author: "reviewer[bot]", state: "APPROVED", commit_id: B, lastEditedAt: null, created_at: at }] : [];
  assert.equal((await f.observe()).prs[0].signals.pending.includes("review:reviewer[bot]"), false);
});
function fixture() {
  let comments = [];
  const ledger = claimed();
  const issue = { number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" } };
  const pr = { number: 9, state: "open", mergeable: true, merge_commit_sha: C,
    head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }), branchSha: async (branch) => branch === "main" ? A : B,
    fileAt: async () => ({ content: "trusted-users: [ntodd]\nsignals:\n  - check: scan\n    blocking: false" }),
    issue: async () => issue, editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: "2026-11-12T00:00:00Z", label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async (n) => n === 9 ? comments : [], reviews: async () => [], threads: async () => [], pull: async () => pr,
    pullStatus: async () => ({ headRefOid: B, baseRefOid: A, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" }),
    compare: async () => ({ behind_by: 0 }), commit: async () => ({ parents: [{ sha: A }, { sha: B }] }),
    checks: async (sha) => raw(sha, [check({ head_sha: sha, conclusion: sha === C ? "failure" : "success" })]),
  };
  const context = { config, sha: A, repo: "ntodd/project", defaultBranch: "main", repositoryId: "42" };
  const observe = () => observeItem({ api, ledger, key: "issue:7", context, rules,
    actions: { inspect: async () => ({ owner: { id: "100", attempt: 1, status: "completed" }, inspected: true, available: false }) } });
  return { api, ledger, pr, context, observe, set comments(value) { comments = value; } };
}

test("required contexts bind to their App and do not accept stale-head or foreign checks", () => {
  const required = requiredChecks(rules);
  for (const checks of [[check({ head_sha: D })], [check({ app: { id: 2 } })], []]) {
    assert.equal(checkFacts(raw(B, checks), required).state, "pending");
  }
  assert.equal(checkFacts(raw(B, [check()]), required).state, "success");
  assert.throws(() => requiredChecks([]), /No required checks/);
});

test("rerun results supersede older check results, while a same-name failing status also blocks", () => {
  const required = [{ name: "CI", appId: null }];
  const facts = raw(B, [check({ id: 1, conclusion: "failure" }), check({ id: 2, conclusion: "success" })]);
  assert.equal(checkFacts(facts, required).state, "success");
  facts.statuses.push({ id: 3, context: "CI", state: "failure", updated_at: at });
  assert.equal(checkFacts(facts, required).state, "failure");
  for (const conclusion of ["neutral", "skipped"]) assert.equal(checkFacts(raw(B, [check({ conclusion })]), required).state, "success");
});

test("current test-merge CI overrides branch-head CI; a stale synthetic merge cannot supply checks", async () => {
  const f = fixture();
  assert.equal((await f.observe()).prs[0].checks.testedSha, C);
  assert.equal((await f.observe()).prs[0].checks.state, "failure");
  f.api.commit = async () => ({ parents: [{ sha: D }, { sha: B }] });
  assert.equal((await f.observe()).prs[0].checks.testedSha, B);
  assert.equal((await f.observe()).prs[0].checks.state, "success");
  f.api.pullStatus = async () => ({ headRefOid: D, baseRefOid: A, mergeable: "MERGEABLE" });
  assert.equal((await f.observe()).prs[0].mergeable, "UNKNOWN");
});

test("same-name main/PR failures are never attributed to main without diagnostic evidence", async () => {
  const f = fixture(), result = await f.observe();
  assert.equal(result.prs[0].checks.failed[0].sharedMain, false);
  assert.equal(result.prs[0].checks.failed[0].signature, null);
});

test("an unacknowledged stop fences publication and a changed/deleted explicit command loses authority", async () => {
  const f = fixture(), op = operation(f.ledger), item = f.ledger.items["issue:7"];
  const stop = { id: 999, body: "/agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at };
  f.comments = [stop];
  assert.equal((await publishObservation(f.api, item, op, f.context.repo)).authorization.valid, false);
  f.comments = [];
  assert.equal((await publishObservation(f.api, item, op, f.context.repo)).authorization.valid, true);
  const comment = { ...stop, body: "/agent respond fix it" };
  const fact = classifyText(comment, "issue-comment", config, { target: 9 });
  const s = ingestCommands(f.ledger, "issue:7", [fact]), recorded = Object.values(s.items["issue:7"].commands)[0];
  const explicit = { ...op, inputs: [recorded.id] };
  assert.equal((await publishObservation(f.api, s.items["issue:7"], explicit, f.context.repo)).authorization.valid, false);
  f.comments = [comment];
  assert.equal((await publishObservation(f.api, s.items["issue:7"], explicit, f.context.repo)).authorization.valid, true);
  f.comments = [{ ...comment, body: "edited" }];
  assert.equal((await publishObservation(f.api, s.items["issue:7"], explicit, f.context.repo)).authorization.valid, false);
});

test("a default-branch switch fences publication even at the same commit or after deleting the former branch", async () => {
  for (const deleted of [false, true]) {
    const f = fixture(), reads = [];
    f.api.repository = async () => ({ id: 42, default_branch: "release" });
    f.api.branchSha = async (ref) => {
      reads.push(ref);
      if (ref === "main" && deleted) throw Object.assign(new Error("former default was deleted"), { status: 404 });
      return ["main", "release"].includes(ref) ? A : B;
    };
    const observed = await publishObservation(f.api, f.ledger.items["issue:7"], operation(f.ledger), f.context.repo);
    assert.equal(observed.authorization.valid, true); assert.equal(observed.open, false);
    assert.equal(observed.baseSha, A); assert.equal(reads.includes("main"), false);
  }
});

test("an open PR aimed at a former default is observed without querying its obsolete CI or base", async () => {
  const f = fixture(); f.context.defaultBranch = "release";
  f.api.repository = async () => ({ id: 42, default_branch: "release" });
  f.api.branchSha = async (ref) => { assert.notEqual(ref, "main"); return ref === "release" ? A : B; };
  f.api.pullStatus = async () => assert.fail("Unsupported PRs must not block owner recovery on CI reads");
  const observed = await f.observe();
  assert.equal(observed.main.ref, "release"); assert.equal(observed.main.sha, A);
  assert.equal(observed.prs.find((p) => p.number === 9).unsupported, true);
  assert.equal(observed.owner.id, "100");
});

test("configured check findings can be revalidated at the publish boundary", async () => {
  const f = fixture();
  f.api.checks = async (sha) => raw(sha, [check({ head_sha: sha, name: "scan", conclusion: "failure", output: { summary: "dependency risk" } })]);
  const finding = (await f.observe()).prs[0].feedback.find((r) => r.sourceId === "check:1");
  assert.ok(finding);
  const op = { ...operation(f.ledger), feedbackInputs: [{ sourceId: finding.sourceId, revision: finding.revision }] };
  assert.equal((await publishObservation(f.api, f.ledger.items["issue:7"], op, f.context.repo)).authorization.valid, true);
  f.api.checks = async (sha) => raw(sha, []);
  assert.equal((await publishObservation(f.api, f.ledger.items["issue:7"], op, f.context.repo)).authorization.valid, false);
});

test("a recorded routed stop/restart fences publishing before its control transition is applied", async () => {
  for (const action of ["stop", "restart"]) {
    const f = fixture(), row = { id: 999, body: `@ntodd-agent ${action}`, user: { login: "ntodd" }, created_at: at, updated_at: at };
    f.comments = [row];
    const fact = classifyText(row, "issue-comment", config, { target: 9 });
    let state = ingestCommands(f.ledger, "issue:7", [fact]);
    const id = Object.keys(state.items["issue:7"].commands)[0];
    state = resolveRoute(state, "issue:7", id, action);
    assert.equal(state.items["issue:7"].paused, false);
    assert.equal((await publishObservation(f.api, state.items["issue:7"], operation(state), f.context.repo)).authorization.valid, false);
    f.comments = [];
    assert.equal((await publishObservation(f.api, state.items["issue:7"], operation(state), f.context.repo)).authorization.valid, true);
  }
});

test("a publisher's own reply does not invalidate resolution, but copied markers from other authors do", async () => {
  const f = fixture(), comments = [{ id: 123, body: "Fix the boundary", author: "ntodd", createdAt: at, updatedAt: at, lastEditedAt: null }];
  f.api.threads = async (number) => number === 9 ? [{ id: "T1", isResolved: false, comments }] : [];
  const feedback = await readFeedback(f.api, { issue: null, prs: [9] }, config);
  const op = operation(f.ledger); op.threadTargets = threadTargets(feedback, 9);
  const effect = { id: threadEffectId("reply", "T1"), type: "thread-reply", thread: "T1" }; op.effects = [effect];
  const before = await publishObservation(f.api, f.ledger.items["issue:7"], op, f.context.repo, "ntodd-agent[bot]");
  const body = `Fixed.\n${effectMarker(op, effect)}`;
  comments.push({ id: 124, body, author: "ntodd-agent[bot]", createdAt: at, updatedAt: at, lastEditedAt: null });
  const after = await publishObservation(f.api, f.ledger.items["issue:7"], op, f.context.repo, "ntodd-agent[bot]");
  assert.equal(before.threadRevisions.T1, after.threadRevisions.T1);
  comments.push({ id: 125, body, author: "outsider", createdAt: at, updatedAt: at, lastEditedAt: null });
  assert.notEqual((await publishObservation(f.api, f.ledger.items["issue:7"], op, f.context.repo, "ntodd-agent[bot]")).threadRevisions.T1, before.threadRevisions.T1);
});
