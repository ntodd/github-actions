import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationItems, runMigration } from "../lib/migration.mjs";
import { parseRequest } from "../lib/controller.mjs";
import { emptyLedger, recordFactoryApp, validateLedger, admit } from "../lib/protocol.mjs";
import { parseConfig } from "../lib/config.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { assertRuntimeIsolation } from "../lib/runtime-guard.mjs";
import { itemUsage } from "../lib/usage.mjs";
import { projectItem } from "../lib/surfaces.mjs";
import { A, B, C, at, claimed } from "./fixtures.mjs";
const app = { id: "123", login: "factory-app[bot]" };

function fixture() {
  let state = recordFactoryApp(emptyLedger("42"), app), writes = 0, isolation = 0, loseResponse = false, beforeWrite;
  const configText = "trusted-users: [ntodd]\nproducers: [flake-hunt]";
  const issue = { number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" }, labels: [{ name: "agent-done" }] };
  const pr = { number: 9, title: "Legacy fix", body: "Fixes #7", state: "open", user: { login: app.login }, labels: [],
    head: { ref: "agent-ready/issue-7", sha: B, repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
  const human = { ...structuredClone(pr), number: 12, user: { login: "ntodd" }, body: "My change", head: { ref: "human", sha: C, repo: { full_name: "ntodd/project" } } };
  const comments = new Map([[7, [{ id: 50, body: "/agent retry", user: { login: "ntodd" }, created_at: "2026-11-11T12:00:00Z", updated_at: "2026-11-11T12:00:00Z" }]],
    [9, []], [12, [{ id: 60, body: "/resolve", user: { login: "ntodd" }, created_at: "2026-11-11T12:00:00Z", updated_at: "2026-11-11T12:00:00Z" }]]]);
  const events = [{ id: 123, event: "labeled", label: { name: "agent-ready" }, actor: { login: "ntodd" }, created_at: "2026-11-11T11:00:00Z" }];
  const repository = { id: 42, full_name: "ntodd/project", default_branch: "main" },
    run = { id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 }, path: ".github/workflows/factory.yml",
      head_branch: "main", head_sha: A, status: "in_progress", event: "workflow_dispatch", actor: { login: "ntodd", type: "User" }, triggering_actor: { login: "ntodd", type: "User" } };
  const env = { GITHUB_REPOSITORY: "ntodd/project", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: A,
    GITHUB_WORKFLOW_REF: "ntodd/project/.github/workflows/factory.yml@refs/heads/main", GITHUB_ACTOR: "ntodd", GITHUB_TRIGGERING_ACTOR: "ntodd",
    GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", FACTORY_TOOLING_SHA: B, FACTORY_TOOLING_REPOSITORY: "ntodd/github-actions" };
  const api = { repository: async () => repository, branchSha: async () => A, fileAt: async () => ({ content: configText }), run: async () => run,
    openIssues: async () => issue.state === "open" ? [issue] : [], openPulls: async () => [pr, human].filter((p) => p.state === "open"),
    issue: async (n) => n === 7 ? issue : n === 9 ? pr : human, pull: async (n) => n === 9 ? pr : human,
    editors: async () => [], events: async (n) => n === 7 ? events : [], comments: async (n) => comments.get(n) ?? [], reviews: async () => [], threads: async () => [],
    closingIssues: async () => [{ number: 7, repository: "ntodd/project" }],
    workflows: async () => [{ id: 1, path: ".github/workflows/agent-ready.yml", state: "disabled_manually" }], liveWorkflowRuns: async () => [] };
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (mutate) => {
    if (beforeWrite) state = beforeWrite(state);
    const next = validateLedger(await mutate(structuredClone(state))); state = next; writes++;
    if (loseResponse) { loseResponse = false; throw new Error("Lost state response after application"); }
    return { state: structuredClone(state) };
  } };
  const context = { repositoryId: "42", repo: "ntodd/project", sha: A, defaultBranch: "main", config: parseConfig(configText) };
  const execute = (request, extra = {}) => runMigration({ api, store, env, context, request, activeApp: app, now: () => at,
    assertRuntime: async () => { isolation++; await assertRuntimeIsolation(api); }, ...extra });
  return { api, store, env, context, issue, pr, human, comments, events, repository, run, execute,
    get state() { return state; }, get writes() { return writes; }, get isolation() { return isolation; },
    plan: (items = [{ issue: 7, prs: [9], disposition: "continue" }]) => execute({ kind: "migrate", items }),
    loseResponse() { loseResponse = true; }, beforeWrite(fn) { beforeWrite = fn; } };
}

test("migration inventory remains read-only with the legacy runtime active and never infers membership from PR prose", async () => {
  const f = fixture(); f.api.workflows = async () => [{ id: 1, path: ".github/workflows/agent-ready.yml", state: "active" }];
  const plan = await f.execute({ kind: "migrate" });
  assert.equal(plan.status, "planned"); assert.equal(plan.inventory.issues[0].number, 7);
  assert.deepEqual(plan.unmapped, [9]); assert.deepEqual(plan.selected, []); assert.equal(plan.applyRequest, null);
  assert.equal(f.writes, 0); assert.equal(f.isolation, 0); assert.deepEqual(f.state.items, {});
});

test("explicit migration revalidates original admission and imports existing PRs without attempts or replayed legacy commands", async () => {
  const f = fixture(), plan = await f.plan();
  assert.equal(f.writes, 0); assert.equal(plan.selected[0].evidence.sourceId, "label:123");
  assert.equal(plan.selected[0].legacyCommands.some((c) => c.sourceId === "issue-comment:50" && c.action === "retry"), true);
  assert.equal(plan.selected[0].feedback, undefined);
  assert.equal((await f.execute(plan.applyRequest)).status, "imported");
  const item = f.state.items["issue:7"];
  assert.deepEqual(item.prs.map((p) => p.number), [9]); assert.deepEqual(item.attempts, []); assert.equal(item.activeOperation, null);
  assert.deepEqual(f.state.operations, {}); assert.equal(item.question, null);
  assert.equal(Object.values(item.commands)[0].status, "superseded"); assert.equal(Object.values(item.commands)[0].acknowledgement, "done");
  assert.equal(item.migration.actor, "ntodd"); assert.equal(item.migration.plan, plan.digest); assert.equal(item.migration.prs[0].head, B);
  assert.equal(f.writes, 1); assert.equal(f.isolation, 2);
  assert.equal(itemUsage(f.state, "issue:7").legacyUnknown, true);
  assert.match(projectItem(f.state, "issue:7")[0].body, /Legacy model cost and Crew minutes were not measured/);
});

test("migration with missing PRs or ambiguous legacy labels asks instead of starting another build", async () => {
  const f = fixture(); f.issue.labels = [{ name: "agent-blocked" }];
  const plan = await f.plan([{ issue: 7, prs: [] }]);
  assert.equal(plan.selected[0].disposition, "question"); assert.match(plan.selected[0].reason, /does not establish/);
  await f.execute(plan.applyRequest);
  const item = f.state.items["issue:7"];
  assert.ok(item.question); assert.equal(item.status.state, "agent-needs-you");
  const next = decideItem(f.state, "issue:7", { authorization: { valid: true, revision: item.revision }, prs: [], feedback: [] }, f.context.config, { now: at });
  assert.equal(next.action, null); assert.deepEqual(f.state.operations, {});
});

test("existing off-default stacks import as visible questions without starting work or requiring a retarget", async () => {
  const f = fixture(); f.human.user.login = app.login; f.human.base = { ref: f.pr.head.ref, sha: B };
  const plan = await f.plan([{ issue: 7, prs: [9, 12], disposition: "continue" }]);
  assert.equal(f.writes, 0); assert.equal(plan.selected[0].disposition, "question");
  assert.match(plan.selected[0].reason, /#12.*base agent-ready\/issue-7/);
  assert.equal((await f.execute(plan.applyRequest)).status, "imported");
  const item = f.state.items["issue:7"];
  assert.deepEqual(item.prs.map((p) => p.number), [9, 12]);
  assert.deepEqual(item.migration.prs.map((p) => [p.number, p.branch, p.base, p.head, p.baseSha]),
    [[9, "agent-ready/issue-7", "main", B, A], [12, "human", "agent-ready/issue-7", C, B]]);
  assert.equal(item.question.reason, plan.selected[0].reason);
  assert.deepEqual(item.attempts, []); assert.deepEqual(f.state.operations, {}); assert.equal(item.activeOperation, null);
  assert.match(projectItem(f.state, "issue:7")[0].body, /#12.*base agent-ready\/issue-7/);
  const next = decideItem(f.state, "issue:7", { authorization: { valid: true, revision: item.revision }, feedback: [], unsupportedStack: true,
    main: { ref: "main", sha: A }, prs: [{ number: 9, state: "open", headSha: B, baseRef: "main" },
      { number: 12, state: "open", headSha: C, baseRef: f.pr.head.ref, unsupported: true }] }, f.context.config, { now: at });
  assert.equal(next.action, null); assert.equal(next.status.state, "agent-needs-you"); assert.equal(f.writes, 1);
});

test("retargeted merged legacy work retains its actual merge base and cannot claim default-branch completion", async () => {
  const f = fixture(); f.pr.base.ref = "feature"; f.pr.state = "closed"; f.pr.merged_at = at; f.pr.merge_commit_sha = C;
  const plan = await f.plan(); assert.equal(plan.selected[0].disposition, "question");
  await f.execute(plan.applyRequest);
  const item = f.state.items["issue:7"], pr = item.prs[0];
  assert.equal(pr.mergeBase, "feature"); assert.equal(pr.mergedSha, C); assert.equal(pr.defaultLanding, undefined);
  assert.equal(item.complete, false); assert.deepEqual(item.attempts, []);
  const next = decideItem(f.state, "issue:7", { authorization: { valid: true, revision: item.revision }, feedback: [],
    main: { ref: "main", sha: A }, prs: [{ number: 9, state: "merged", mergedSha: C, baseRef: "feature" }] }, f.context.config, { now: at });
  assert.equal(next.action.type, "ask"); assert.match(next.action.reason, /feature.*default-branch coverage is unverified/);
});

test("a reviewed stop disposition persists a pause with the existing membership", async () => {
  for (const base of ["main", "feature"]) {
    const f = fixture(); f.pr.base.ref = base;
    const plan = await f.plan([{ issue: 7, prs: [9], disposition: "stop" }]);
    await f.execute(plan.applyRequest);
    assert.equal(f.state.items["issue:7"].paused, true); assert.equal(f.state.items["issue:7"].generation, 1);
    assert.equal(f.state.items["issue:7"].prs[0].number, 9); assert.equal(f.state.items["issue:7"].attempts.length, 0);
  }
});

test("migration recovers a lost state response without repeating the import or changing later work", async () => {
  const f = fixture(), plan = await f.plan(); f.loseResponse();
  await assert.rejects(f.execute(plan.applyRequest), /Lost state response/);
  const before = structuredClone(f.state);
  assert.equal((await f.execute(plan.applyRequest)).status, "already-imported");
  assert.equal(f.writes, 1); assert.deepEqual(f.state, before);
});

test("stale migration digests cannot accept changed heads, prose, issue revisions, sources or conversation", async () => {
  for (const change of [
    (f) => { f.pr.head.sha = C; }, (f) => { f.pr.body = "Changed PR scope"; }, (f) => { f.issue.body = "Revised task"; },
    (f) => { f.pr.base.ref = "feature"; }, (f) => { f.pr.base.sha = C; },
    (f) => { f.env.FACTORY_TOOLING_SHA = C; },
    (f) => { f.events[0].actor.login = "untrusted"; },
    (f) => { f.comments.get(7).push({ id: 51, body: "/agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at }); },
  ]) {
    const f = fixture(), plan = await f.plan(); change(f);
    await assert.rejects(f.execute(plan.applyRequest)); assert.equal(f.writes, 0); assert.deepEqual(f.state.items, {});
  }
});

test("migration rechecks facts after isolation and refuses a ledger conflict instead of overwriting history", async () => {
  const f = fixture(), plan = await f.plan();
  await assert.rejects(f.execute(plan.applyRequest, { assertRuntime: async () => { f.pr.head.sha = C; } }), /facts changed/);
  assert.equal(f.writes, 0);
  const other = fixture(), approved = await other.plan();
  other.beforeWrite((state) => admit(state, { key: "issue:8", revision: "e".repeat(64), evidence: { sourceId: "label:2" } }));
  await assert.rejects(other.execute(approved.applyRequest), /Factory history changed/);
  assert.equal(other.state.items["issue:7"], undefined); assert.ok(other.state.items["issue:8"]); assert.equal(other.writes, 0);
});

test("untrusted edits, foreign branches, another App and unrelated closing references cannot be migrated", async () => {
  for (const change of [
    (f) => { f.api.editors = async () => ["untrusted"]; }, (f) => { f.pr.head.repo.full_name = "someone/fork"; },
    (f) => { f.pr.user.login = "another-app[bot]"; },
    (f) => { f.pr.base.ref = "../invalid"; },
    (f) => { f.pr.head.ref = "factory-state"; },
    (f) => { f.api.closingIssues = async () => [{ number: 8, repository: "ntodd/project" }]; },
    (f) => { f.api.closingIssues = async () => [{ number: 7, repository: "someone/project" }]; },
  ]) { const f = fixture(); change(f); await assert.rejects(f.plan()); assert.equal(f.writes, 0); }
});

test("migration application requires terminal legacy runs and the verified App identity", async () => {
  for (const change of [
    (f) => { f.api.workflows = async () => [{ id: 1, path: ".github/workflows/agent-ready.yml", state: "active" }]; },
    (f) => { f.api.liveWorkflowRuns = async () => [{ id: 999, status: "queued" }]; },
  ]) { const f = fixture(), plan = await f.plan(); change(f); await assert.rejects(f.execute(plan.applyRequest)); assert.equal(f.writes, 0); }
  const f = fixture(), plan = await f.plan();
  await assert.rejects(f.execute(plan.applyRequest, { activeApp: { ...app, id: "999" } }), /factory App changed/);
  assert.equal(f.writes, 0);
});

test("migration cannot import while another factory worker still owns unfinished work", async () => {
  const f = fixture(), busy = claimed(), item = busy.items["issue:7"], op = busy.operations["op-1"];
  item.key = "issue:8"; item.prs[0].number = 88; op.item = "issue:8"; op.target.number = 88;
  await f.store.transact((s) => ({ ...s, items: { "issue:8": item }, operations: { "op-1": op } }));
  const plan = await f.plan(), before = structuredClone(f.state);
  await assert.rejects(f.execute(plan.applyRequest), /unfinished effects/);
  assert.deepEqual(f.state, before); assert.equal(f.writes, 1);
});

test("migration cannot replace existing records or claim another item's PR", async () => {
  for (const key of ["issue:7", "issue:8"]) {
    const f = fixture(); await f.store.transact((s) => admit(s, { key, revision: "e".repeat(64), evidence: { sourceId: "label:2" },
      prs: [{ number: 9, state: "open", required: true, mergedSha: null, acceptedClosure: false }] }));
    const before = structuredClone(f.state); await assert.rejects(f.plan(), /already/); assert.deepEqual(f.state, before);
  }
});

test("human PR migration retains the original request and does not enroll ongoing maintenance", async () => {
  const f = fixture(), plan = await f.plan([{ pr: 12, disposition: "continue" }]);
  assert.equal(plan.selected[0].evidence.sourceId, "issue-comment:60");
  await f.execute(plan.applyRequest); const item = f.state.items["pr:12"];
  assert.equal(item.evidence.own, true); assert.equal(item.maintenanceComplete, true);
  const next = decideItem(f.state, "pr:12", { authorization: { valid: true, revision: item.revision }, feedback: [],
    prs: [{ number: 12, state: "open", headSha: C, baseRef: "main", baseSha: A, mergeable: "CONFLICTING" }] }, f.context.config, { now: at });
  assert.equal(next.action, null); assert.equal(f.state.operations["op-1"], undefined);
});

test("closed legacy issues preserve actual merged PR outcomes without a replacement build", async () => {
  const f = fixture(); f.issue.state = "closed"; f.pr.state = "closed"; f.pr.merged_at = at; f.pr.merge_commit_sha = C;
  const plan = await f.plan(); await f.execute(plan.applyRequest);
  assert.equal(f.state.items["issue:7"].prs[0].state, "merged"); assert.equal(f.state.items["issue:7"].prs[0].mergedSha, C);
  assert.equal(f.state.items["issue:7"].attempts.length, 0);
});

test("migration reuses the registered producer admission contract without promoting bot labels to human commands", async () => {
  const f = fixture(); f.issue.user.login = "github-actions[bot]";
  f.issue.body = "A reproduced failure\n<!-- flake-hunt:existing-source -->"; f.events[0].actor.login = "github-actions[bot]";
  const plan = await f.plan(); await f.execute(plan.applyRequest);
  assert.equal(f.state.items["issue:7"].evidence.producer.source, "flake-hunt");
  assert.equal(f.state.items["issue:7"].migration.admission.sourceId, "label:123");
  assert.equal(Object.values(f.state.items["issue:7"].commands).some((c) => c.sourceId === "label:123"), false);
  assert.equal(f.state.items["issue:7"].attempts.length, 0);
});

test("only a trusted manual default-branch run can inspect or apply migration", async () => {
  for (const patch of [{ GITHUB_EVENT_NAME: "issue_comment" }, { GITHUB_ACTOR: "untrusted", GITHUB_TRIGGERING_ACTOR: "untrusted" },
    { GITHUB_TRIGGERING_ACTOR: "someone-else" }, { GITHUB_REF: "refs/heads/topic" }, { FACTORY_TOOLING_REPOSITORY: "someone/tools" }, { FACTORY_TOOLING_SHA: "main" }]) {
    const f = fixture(); Object.assign(f.env, patch); await assert.rejects(f.plan()); assert.equal(f.writes, 0);
  }
  const f = fixture(); f.run.actor.type = "Bot"; await assert.rejects(f.plan()); assert.equal(f.writes, 0);
  const moved = fixture(); moved.repository.default_branch = "release";
  await assert.rejects(moved.plan(), /default branch changed/); assert.equal(moved.writes, 0);
});

test("migration request and stored provenance reject ambiguous membership and malformed identities", async () => {
  for (const request of [{ kind: "migrate", apply: "true" }, { kind: "migrate", apply: true, items: [{ issue: 7, prs: [9] }] },
    { kind: "migrate", digest: "a".repeat(64) }, { kind: "migrate", target: 7 },
    { kind: "migrate", items: [{ issue: 7, prs: [9, 9] }] }, { kind: "migrate", items: [{ issue: 7, prs: [9] }, { pr: 9 }] },
    { kind: "migrate", items: [{ issue: 7, prs: [], disposition: "continue" }] }]) assert.throws(() => parseRequest(JSON.stringify(request)));
  assert.deepEqual(migrationItems([{ issue: 7, prs: [9] }]), [{ issue: 7, prs: [9], disposition: "question" }]);
  const f = fixture(), plan = await f.plan(); await f.execute(plan.applyRequest);
  for (const change of [(m) => { m.plan = "wrong"; }, (m) => { m.run.attempt = 0; }, (m) => { m.prs[0].number = 99; }, (m) => { m.prs[0].head = "wrong"; }]) {
    const state = structuredClone(f.state); change(state.items["issue:7"].migration);
    assert.throws(() => validateLedger(state), (e) => e.code === "corrupt");
  }
});
