import { test } from "node:test";
import assert from "node:assert/strict";
import { runController, claimOperation, parseRequest } from "../lib/controller.mjs";
import { emptyLedger, validateLedger, recordFactoryApp } from "../lib/protocol.mjs";
import { publishOperation } from "../lib/publish.mjs";
import { actionsClient } from "../lib/actions.mjs";
import { publishObservation } from "../lib/observe.mjs";
import { mentionRouter } from "../lib/router.mjs";
import { itemUsage } from "../lib/usage.mjs";
import { preparationOutcome } from "../lib/project-setup.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A, B, C, D, at, run } from "./fixtures.mjs";

function fixture() {
  let state = emptyLedger("42"), branch = null, pr = null, owner = null, available = false;
  const effects = [], source = { number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" }, labels: [{ name: "agent-ready" }] };
  const config = "trusted-users: [ntodd]";
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }), fileAt: async () => ({ content: config }),
    branchSha: async (name) => { if (name === "main") return A; if (branch) return branch; throw Object.assign(new Error("missing"), { status: 404 }); },
    openIssues: async () => [source], openPulls: async () => pr ? [pr] : [], issue: async () => source,
    editors: async () => [], comments: async () => [], reviews: async () => [], threads: async () => [],
    events: async () => [{ id: 123, event: "labeled", created_at: "2026-11-12T00:00:00Z", label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    branchRules: async () => [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }], strict_required_status_checks_policy: true } }],
    pull: async () => pr, compare: async () => ({ behind_by: 0 }),
    pullStatus: async () => ({ headRefOid: C, baseRefOid: A, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" }),
    checks: async (sha) => ({ sha, statuses: [], checkRuns: [{ id: 1, head_sha: sha, name: "CI", app: { id: 1 }, status: "completed", conclusion: "success" }] }),
    run: async () => ({ id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 },
      path: ".github/workflows/factory.yml", head_sha: A, head_branch: "main", event: "workflow_dispatch", status: "in_progress" }),
  };
  const write = { dispatch: async (...args) => effects.push(["dispatch", ...args]), closeIssue: async (n) => { effects.push(["close", n]); source.state = "closed"; } };
  const actions = {
    inspect: async () => ({ owner, inspected: owner?.status === "completed", available }),
    download: async (op) => ({ artifact: { id: "200", digest: `sha256:${"e".repeat(64)}`, repositoryId: "42", run,
      workflowPath: op.worker.workflowPath, headSha: A, expired: false }, dispose() {}, proposal: {
      schemaVersion: 1, operationId: op.id, run, outcome: "ready", pullRequest: { title: "Fix it", body: "Issue: #7" }, effects: [
        { id: "push", type: "push", branch: op.target.branch, expectedHead: null, commit: C, baseSha: A },
      ],
    } }),
  };
  const publisher = async ({ key, operationId, run: publisherRun }) => publishOperation({ store, itemKey: key, operationId, publisherRun,
    observe: async (item) => ({ authorization: { valid: true, revision: item.revision }, open: true, head: branch, baseSha: A }),
    writer: { validate: async () => {}, inspect: async () => ({ outcome: "unknown" }), apply: async (effect) => {
      effects.push([effect.type]);
      if (effect.type === "push") { branch = effect.commit; return { outcome: "applied", evidence: { kind: "branch-head", commit: C } }; }
      pr = { number: 9, state: "open", head: { sha: C, ref: effect.head, repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
      return { outcome: "applied", evidence: { kind: "pull-request", number: 9, state: "open", head: effect.head, base: "main", commit: C } };
    } } });
  const pass = (extra = {}) => runController({ api, write, store, actions, repo: "ntodd/project", toolingSha: B,
    run: { id: "900", attempt: 1 }, now: () => at, operationId: () => "op-1", publish: publisher, ...extra });
  return { api, store, effects, actions, pass, source, get state() { return state; }, get pr() { return pr; },
    finish() { owner = { ...run, status: "completed", conclusion: "success" }; available = true; } };
}

test("one issue traverses reservation, exclusive admission, terminal artifact, publication, review and completion", async () => {
  const f = fixture();
  await f.pass();
  assert.equal(f.state.operations["op-1"].phase, "prepared");
  assert.equal(f.state.operations["op-1"].dispatch.attempts.length, 1);
  assert.equal(f.effects.filter((e) => e[0] === "dispatch").length, 1);
  const claim = () => claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  assert.equal((await claim()).claimed, true);
  assert.equal((await claim()).claimed, false);
  f.finish();
  await f.pass();
  assert.equal(f.state.operations["op-1"].phase, "done");
  assert.deepEqual(f.effects.filter((e) => ["push", "pull-request"].includes(e[0])), [["push"], ["pull-request"]]);
  await f.pass();
  assert.equal(f.state.items["issue:7"].status.state, "agent-review");
  assert.equal(f.state.items["issue:7"].handover.head, C);
  f.pr.state = "closed"; f.pr.merged_at = at; f.pr.merge_commit_sha = C;
  await f.pass();
  assert.equal(f.state.items["issue:7"].complete, true);
  assert.deepEqual(f.effects.at(-1), ["close", 7]);
});

test("handover and review-bot readiness keep the observed head when a push races the controller action", async () => {
  for (const readyOnly of [false, true]) {
    const f = fixture(); await f.pass();
    await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
      context: { sha: A, defaultBranch: "main", config: {} } });
    f.finish(); await f.pass({ maxPasses: 1 }); await f.pass({ maxPasses: 1 });
    assert.equal(f.state.operations["op-1"].phase, "done");
    let calls = 0, changed = false;
    const surfaces = { acknowledge: async () => [], render: async () => {
      if (!changed) { f.pr.head.sha = D; changed = true; }
    }, handover: async () => { calls++; return { status: "applied" }; } };
    let extra = {};
    if (readyOnly) extra = { observe: async () => ({ authorization: { valid: true, revision: f.state.items["issue:7"].revision },
      feedback: [], prs: [{ number: 9, state: "open", headSha: C, baseSha: A, mergeable: "MERGEABLE", draft: true,
        checks: { state: "success", headSha: C, failed: [] }, signals: { pending: ["review:reviewer[bot]"] } }] }) };
    const result = await f.pass({ maxPasses: 1, surfaces, ...extra });
    const plan = result.plans.find((p) => p.action?.type === (readyOnly ? "ready-for-bots" : "handover"));
    assert.equal(calls, 0); assert.equal(f.state.items["issue:7"].handover, undefined);
    assert.equal(plan.action.head, C);
    assert.equal(result.outcomes.some((o) => o.status === "interrupted"), false);
    assert.equal(result.outcomes.some((o) => o.status === "waiting" && /head changed/.test(o.reason)), true);
  }
});

test("revoked admission retires an unclaimed reservation and needs a fresh trusted source even after trust returns", async () => {
  const f = fixture(), events = f.api.events;
  await f.pass();
  f.api.events = async () => [];
  await f.pass();
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  assert.equal(f.state.items["issue:7"].authorizationRevoked, true);
  const generation = f.state.items["issue:7"].generation;
  const question = f.state.items["issue:7"].question.id;
  await f.pass(); assert.equal(f.state.items["issue:7"].generation, generation);
  f.api.events = events; await f.pass();
  assert.equal(f.state.items["issue:7"].question.id, question);
  assert.equal(f.effects.filter(([kind]) => kind === "dispatch").length, 1);
  f.api.comments = async () => [{ id: 1001, body: "/agent build keep the existing scope", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  await f.pass({ operationId: () => "op-2" });
  assert.equal(f.state.items["issue:7"].evidence.sourceId, "issue-comment:1001");
  assert.equal(f.state.items["issue:7"].authorizationRevoked, undefined);
  assert.equal(f.state.operations["op-2"].phase, "prepared");
  assert.equal(f.state.items["issue:7"].attempts.length, 2);
  assert.equal(f.effects.filter(([kind]) => kind === "dispatch").length, 2);
});

test("a fresh trusted relabel can replace revoked admission without resetting attempts", async () => {
  const f = fixture(); await f.pass();
  f.api.events = async () => []; await f.pass();
  f.api.events = async () => [{ id: 124, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }];
  await f.pass({ operationId: () => "op-2" });
  assert.equal(f.state.items["issue:7"].evidence.sourceId, "label:124");
  assert.equal(f.state.items["issue:7"].authorizationRevoked, undefined);
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  assert.equal(f.state.operations["op-2"].phase, "prepared");
  assert.equal(f.state.items["issue:7"].attempts.length, 2);
});

test("a same-commit default-branch switch rejects old admission and replans the build against the new branch", async () => {
  const f = fixture(); await f.pass();
  f.api.repository = async () => ({ id: 42, default_branch: "release" });
  f.api.branchSha = async (ref) => { if (["main", "release"].includes(ref)) return A; throw Object.assign(new Error("missing"), { status: 404 }); };
  f.api.run = async () => ({ id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 }, path: ".github/workflows/factory.yml",
    head_sha: A, head_branch: "release", event: "workflow_dispatch", status: "in_progress" });
  assert.equal((await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "release" } })).claimed, false);
  assert.equal(f.state.operations["op-1"].owner, null);
  const result = await f.pass({ operationId: () => "op-2" });
  assert.equal(result.outcomes.some((o) => o.status === "interrupted"), false);
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  assert.equal(f.state.operations["op-2"].base.ref, "release");
  assert.equal(f.state.operations["op-2"].base.sha, A);
  assert.equal(f.state.operations["op-2"].owner, null);
  assert.equal(f.state.items["issue:7"].authorizationRevoked, undefined);
  assert.equal(f.state.items["issue:7"].attempts.length, 2);
});

test("known default-branch changes still cancel obsolete ownership when CI observation is unavailable", async () => {
  const f = fixture(); await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main" } });
  f.api.repository = async () => ({ id: 42, default_branch: "release" });
  f.api.branchSha = async () => A;
  f.api.branchRules = async () => { throw new Error("rules API unavailable"); };
  const cancelled = [], result = await f.pass({ maxPasses: 1, write: { cancelRun: async (id) => { cancelled.push(id); } } });
  assert.equal(result.plans[0].action.type, "cancel-owner");
  assert.deepEqual(cancelled, ["100"]);
  assert.equal(f.state.operations["op-1"].owner.id, "100");
  assert.equal(f.state.operations["op-1"].cancel.attempts.length, 1);
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
});

test("the real Actions adapter can retire a terminal owner from the former default before replacing it", async () => {
  const f = fixture(); await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main" } });
  f.api.repository = async () => ({ id: 42, default_branch: "release" });
  const branchSha = f.api.branchSha;
  f.api.branchSha = async (ref) => ref === "release" ? A : branchSha(ref);
  let inspections = 0;
  const adapter = actionsClient({ token: "read", repo: "ntodd/project", fetch: async (url) => {
    if (url.endsWith("/attempts/1")) {
      inspections++;
      return Response.json({ id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 }, path: ".github/workflows/factory.yml",
        head_sha: A, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "cancelled" });
    }
    assert.match(url, /\/artifacts\?/); return Response.json({ artifacts: [] });
  } });
  const result = await f.pass({ actions: { inspect: adapter.inspect }, operationId: () => "op-2" });
  assert.equal(result.outcomes.some((o) => o.status === "interrupted"), false);
  assert.equal(inspections, 1);
  assert.equal(f.state.operations["op-1"].owner.status, "completed");
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  assert.equal(f.state.operations["op-2"].phase, "prepared");
  assert.equal(f.state.operations["op-2"].base.ref, "release");
});

test("a default switch between planning and reservation cannot allocate maintenance against the former default", async () => {
  const f = fixture(); await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main" } });
  f.finish(); await f.pass(); let reads = 0;
  f.api.repository = async () => ({ id: 42, default_branch: ++reads === 1 ? "main" : "release" });
  const branchSha = f.api.branchSha;
  f.api.branchSha = async (ref) => ref === "release" ? A : branchSha(ref);
  f.api.comments = async (n) => n === 9 ? [{ id: 1001, body: "/agent update", user: { login: "ntodd" }, created_at: at, updated_at: at }] : [];
  const result = await f.pass({ operationId: () => "op-2" });
  assert.equal(result.outcomes.some((o) => o.status === "interrupted"), false);
  assert.equal(f.state.operations["op-2"], undefined);
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  assert.match(f.state.items["issue:7"].question.reason, /#9.*default branch.*release/);
});

test("a fresh command cannot override untrusted issue edits during readmission", async () => {
  const f = fixture(); await f.pass();
  f.api.fileAt = async () => ({ content: "trusted-users: [someone-else]" }); await f.pass();
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  f.api.fileAt = async () => ({ content: "trusted-users: [ntodd]" });
  f.api.editors = async () => ["outsider"];
  f.api.comments = async () => [{ id: 1001, body: "/agent build", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  await f.pass({ operationId: () => "op-2" });
  assert.equal(f.state.items["issue:7"].authorizationRevoked, true);
  assert.match(f.state.items["issue:7"].question.reason, /untrusted actor/);
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  assert.equal(f.state.operations["op-2"], undefined);
});

test("a fresh restart on a closed issue can readmit first without losing its queued restart", async () => {
  const f = fixture(); await f.pass();
  f.api.events = async () => []; await f.pass(); f.source.state = "closed";
  f.api.comments = async () => [{ id: 1001, body: "/agent restart", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  const starts = [];
  const result = await f.pass({ maxPasses: 2, restart: async (args) => { starts.push(args); } });
  assert.equal(f.state.items["issue:7"].authorizationRevoked, undefined);
  assert.equal(f.state.items["issue:7"].evidence.sourceId, "issue-comment:1001");
  assert.equal(f.state.items["issue:7"].restart.phase, "requested");
  assert.equal(starts.length, 1);
  assert.equal(result.outcomes.some((o) => o.status === "interrupted"), false);
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
});

test("runtime conflict prevents admission and new work, including a conflict first observed after planning", async () => {
  const f = fixture(), conflict = () => { throw new Error("Legacy runtime conflict"); };
  await assert.rejects(f.pass({ assertRuntime: conflict }), /Legacy runtime/);
  assert.deepEqual(f.state.items, {}); assert.deepEqual(f.effects, []);
  const report = await f.pass({ dryRun: true, assertRuntime: conflict });
  assert.equal(report.admissions.length, 1); assert.deepEqual(f.state.items, {});
  let calls = 0;
  const pass = await f.pass({ assertRuntime: async () => { if (++calls > 1) conflict(); } });
  assert.equal(pass.outcomes.some((o) => o.status === "interrupted" && o.reason === "Legacy runtime conflict"), true);
  assert.deepEqual(f.state.operations, {}); assert.deepEqual(f.effects, []);
});

test("controller publication retains costs and later events do not recount the same worker", async () => {
  const f = fixture(), originalDownload = f.actions.download;
  let measurements = 0;
  f.actions.measure = async (op) => { measurements++; return { source: "actions-job", run, jobId: "321", runner: op.worker.runner,
    ran: true, startedAt: at, completedAt: "2026-11-12T12:02:00Z", durationMs: 120000 }; };
  f.actions.download = async (op) => {
    const result = await originalDownload(op);
    result.proposal.metrics = { schemaVersion: 1, cost: 0.12, turns: 3, complete: true,
      phases: [{ phase: "work", cost: 0.12, turns: 3, complete: true }] };
    return result;
  };
  await f.pass();
  assert.equal(f.state.operations["op-1"].worker.runner, "crew-l");
  assert.equal(f.state.operations["op-1"].worker.model, "opus");
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  f.finish(); await f.pass(); await f.pass();
  assert.equal(f.state.operations["op-1"].phase, "done");
  assert.equal(itemUsage(f.state, "issue:7").workerReportedUsd, 0.12);
  assert.equal(itemUsage(f.state, "issue:7").crewMinutes, 2);
  assert.equal(measurements, 1);
});

test("broad observation failures still journal publication read recovery without losing an accepted result", async () => {
  const f = fixture(); await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main" } });
  f.finish(); await f.pass({ maxPasses: 1 });
  assert.equal(f.state.operations["op-1"].phase, "result-ready");
  let reads = 0, writes = 0;
  f.api.editors = async () => { reads++; throw Object.assign(new Error("private read detail"), { status: 503 }); };
  const publish = async ({ key, operationId, run: publisherRun }) => publishOperation({ store: f.store, itemKey: key, operationId, publisherRun,
    observe: (item, op) => publishObservation(f.api, item, op, "ntodd/project"), now: () => at,
    writer: { validate: async () => { writes++; assert.fail(); }, inspect: async () => { writes++; assert.fail(); }, apply: async () => { writes++; assert.fail(); } } });
  const first = await f.pass({ publish, maxPasses: 1 });
  assert.ok(first.outcomes.some((o) => o.action === "publish" && o.status === "interrupted"));
  const read = Object.values(f.state.items["issue:7"].preflights)[0];
  assert.equal(read.operation, "op-1"); assert.equal(read.stage, "plan"); assert.equal(read.code, "http:503");
  const second = await f.pass({ publish, maxPasses: 1 });
  assert.ok(second.outcomes.some((o) => o.action === "publish" && o.status === "waiting"));
  assert.equal(reads, 3); assert.equal(writes, 0);
  assert.equal(f.state.operations["op-1"].phase, "result-ready");
  assert.equal(f.state.items["issue:7"].question, null);
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  assert.equal(JSON.stringify(f.state).includes("private read detail"), false);
});

for (const phase of ["worker", "setup"]) test(`controller withholds ${phase}-secret-enabled worker prose from durable state`, async () => {
  const f = fixture(), original = f.actions.download, secret = "selected-project-secret";
  f.api.fileAt = async () => ({ content: `trusted-users: [ntodd]\nenvironment: {${phase}-secrets: [DATABASE_PASSWORD]}` });
  await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  f.actions.download = async (op) => {
    const result = await original(op);
    result.proposal = { ...result.proposal, outcome: "needs-you", reason: `Required project secret is missing from SETUP_SECRETS: DATABASE_PASSWORD (${secret})`, effects: [] };
    return result;
  };
  f.finish(); await f.pass(); await f.pass();
  assert.equal(JSON.stringify(f.state).includes(secret), false);
  assert.match(f.state.items["issue:7"].question.reason, /redacted result report/);
});

for (const phase of ["worker", "setup"]) test(`a ${phase}-secret preparation question reaches the issue without model work, a push or a replacement build`, async (t) => {
  const f = fixture();
  f.api.fileAt = async () => ({ content: `trusted-users: [ntodd]\nenvironment: {${phase}-secrets: [DATABASE_PASSWORD]}` });
  await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  const root = mkdtempSync(join(tmpdir(), "factory-prepare-question-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const proposal = preparationOutcome({ assignment: { operation: f.state.operations["op-1"] }, run, resultDir: root,
    outcome: "needs-you", reason: "Required project secret is missing from SETUP_SECRETS: DATABASE_PASSWORD" });
  const download = f.actions.download;
  f.actions.download = async (op) => ({ ...await download(op), proposal });
  f.finish(); await f.pass(); await f.pass();
  assert.match(f.state.items["issue:7"].question.reason, /DATABASE_PASSWORD/);
  assert.equal(f.state.items["issue:7"].status.state, "agent-needs-you");
  assert.equal(itemUsage(f.state, "issue:7").workerReportedUsd, 0);
  assert.equal(itemUsage(f.state, "issue:7").workerUnknown, 0);
  assert.equal(Object.keys(f.state.operations).length, 1);
  assert.equal(f.effects.filter(([kind]) => ["push", "pull-request"].includes(kind)).length, 0);
});

test("the real mention adapter journals usage against the reserved request before resolving it", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  f.api.comments = async () => [{ id: 999, body: "@ntodd-agent status", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  let calls = 0;
  const route = mentionRouter({ apiKey: "key", fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ id: "resp_123", status: "completed", usage: { input_tokens: 20, output_tokens: 10,
      total_tokens: 30, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 4 } },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ action: "status", effort: null }) }] }] }));
  } });
  await f.pass({ route }); await f.pass({ route });
  assert.equal(calls, 1);
  assert.equal(itemUsage(f.state, "issue:7").routingTokens.total, 30);
  assert.equal(itemUsage(f.state, "issue:7").routingUnpriced, 1);
  assert.equal(itemUsage(f.state, "issue:7").routingUnknown, 0);
  assert.deepEqual(f.state.operations, {});
});

test("a trusted public answer accepts a closed PR without merging or starting replacement work", async () => {
  const f = fixture();
  await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  f.finish(); await f.pass();
  f.pr.state = "closed";
  await f.pass();
  assert.equal(f.state.items["issue:7"].question.kind, "pr-closure");
  assert.equal(f.source.state, "open");
  const when = "2026-11-12T12:01:00Z";
  f.api.comments = async (number) => number === 7 ? [{ id: 998, body: "/agent answer accept-closure #9", user: { login: "ntodd" },
    created_at: at, updated_at: when }, { id: 997, body: "/agent answer accept-closure #9", user: { login: "stranger" },
    created_at: when, updated_at: when }] : [];
  await f.pass({ now: () => "2026-11-12T12:02:00Z" });
  assert.equal(f.state.items["issue:7"].complete, false);
  assert.equal(f.state.items["issue:7"].prs[0].acceptedClosure, false);
  f.api.comments = async (number) => number === 7 ? [{ id: 999, body: "/agent answer accept-closure #9", user: { login: "ntodd" },
    created_at: when, updated_at: when }] : [];
  await f.pass({ now: () => "2026-11-12T12:02:00Z" });
  assert.equal(f.state.items["issue:7"].complete, true);
  assert.equal(f.source.state, "closed");
  assert.equal(f.state.items["issue:7"].prs[0].dispositions[0].sourceId, "issue-comment:999");
  await f.pass({ now: () => "2026-11-12T12:03:00Z" });
  assert.equal(f.effects.filter(([kind]) => kind === "dispatch").length, 1);
  assert.equal(f.effects.filter(([kind]) => kind === "pull-request").length, 1);
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
});

test("protected App identity prevents its own review and command text from starting more work", async () => {
  const f = fixture();
  await f.store.transact((s) => recordFactoryApp(s, { id: "123", login: "actual-factory[bot]" }));
  await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  f.finish(); await f.pass();
  f.api.fileAt = async () => ({ content: "trusted-users: [ntodd]\nhandle: different-handle\nreview-bots: ['actual-factory[bot]']" });
  f.api.reviews = async () => [{ id: 998, body: "Make more changes", author: "actual-factory[bot]", state: "CHANGES_REQUESTED",
    lastEditedAt: null, commitSha: C, createdAt: at }];
  f.api.comments = async (number) => number === 9 ? [{ id: 999, body: "/agent restart", user: { login: "actual-factory[bot]" },
    created_at: at, updated_at: at }] : [];
  await f.pass();
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  assert.equal(f.state.items["issue:7"].status.state, "agent-waiting");
  assert.equal(f.state.items["issue:7"].status.wait.kind, "signals");
  assert.deepEqual(f.state.items["issue:7"].commands, {});
  assert.equal(f.effects.filter(([kind]) => kind === "dispatch").length, 1);
});

test("dry runs neither admit issues nor reserve/dispatch operations", async () => {
  const f = fixture();
  const result = await f.pass({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(f.state.items, {});
  assert.deepEqual(f.effects, []);
  assert.deepEqual(result.admissions, [{ key: "issue:7", requestOnly: false, sourceId: "label:123" }]);
  assert.equal(result.plans[0].action.type, "reserve");
});

test("an ambiguous dispatch keeps its reservation for recovery rather than allocating replacement work", async () => {
  const f = fixture();
  const write = { dispatch: async () => { throw new Error("connection lost after dispatch"); } };
  const result = await f.pass({ write });
  assert.equal(result.outcomes[0].status, "interrupted");
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  await f.pass();
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  assert.equal(f.effects.length, 0);
});

test("dispatch payloads cannot smuggle assignments or executable options", () => {
  assert.deepEqual(parseRequest('{"kind":"reconcile","target":7}'), { kind: "reconcile", target: 7 });
  for (const value of ['{"kind":"worker","item":"issue:7","operation":"op-1","head":"evil"}', '{"kind":"worker","item":"bad","operation":"op-1"}', '{"kind":"reconcile","target":-1}']) {
    assert.throws(() => parseRequest(value));
  }
});

test("an unavailable observation leaves the existing item waiting without inventing terminal ownership", async () => {
  const f = fixture(); await f.pass();
  const result = await f.pass({ observe: async () => { throw new Error("API observation timed out"); } });
  assert.equal(f.state.items["issue:7"].status.state, "agent-waiting");
  assert.equal(f.state.items["issue:7"].status.wait.kind, "observation");
  assert.equal(f.state.operations["op-1"].phase, "prepared");
  assert.equal(result.outcomes.length, 0);
});

test("a stop mention is routed while a worker is live, then fences and cancels that owner", async () => {
  const f = fixture(); await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  f.api.comments = async () => [{ id: 999, body: "@ntodd-agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  let routed = 0, cancelled = 0;
  await f.pass({ route: async () => { routed++; return { action: "stop", effort: null }; },
    write: { cancelRun: async (id) => { assert.equal(id, run.id); cancelled++; } } });
  assert.equal(routed, 1);
  assert.equal(cancelled, 1);
  assert.equal(f.state.items["issue:7"].paused, true);
  const duplicate = await f.pass({ route: async () => { routed++; throw new Error("A duplicate event must not reroute"); } });
  assert.equal(routed, 1);
  assert.equal(duplicate.outcomes.some((o) => o.action === "route" && o.status === "interrupted"), false);
  assert.equal(f.effects.filter((e) => e[0] === "dispatch").length, 1);
});

test("routing API failures back off, exhaust three requests, and become one durable clarification", async () => {
  const f = fixture(); await f.pass();
  // No active worker is necessary for an ambiguous request; even an existing
  // question must allow a new mention to reach the router.
  await f.store.transact((s) => { s.items["issue:7"].paused = true; return s; });
  f.api.comments = async () => [{ id: 999, body: "@ntodd-agent what now?", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  let calls = 0;
  const route = async () => { calls++; throw new Error("API unavailable"); };
  for (const now of [at, at, "2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z", "2026-11-12T13:00:00Z"]) await f.pass({ route, now: () => now });
  assert.equal(calls, 3);
  const request = Object.values(f.state.items["issue:7"].commands).find((c) => c.sourceId === "issue-comment:999");
  assert.equal(request.action, "clarify");
  assert.equal(request.text, "@ntodd-agent what now?");
  assert.equal(request.routingAttempts.length, 3);
});

test("exact commands never call the mention router", async () => {
  const f = fixture(); await f.pass();
  f.api.comments = async () => [{ id: 999, body: "/agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  let routed = 0;
  const result = await f.pass({ route: async () => { routed++; throw new Error("Exact command called the model"); } });
  assert.equal(routed, 0);
  assert.equal(result.outcomes.some((o) => o.action === "route" && o.status === "interrupted"), false);
  assert.equal(f.state.items["issue:7"].paused, true);
});

test("a trusted relabel resumes the same work item without orphaning its recorded PR", async () => {
  const f = fixture(); await f.pass();
  await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main", config: {} } });
  f.finish(); await f.pass();
  const old = f.api.events;
  await f.store.transact((s) => { s.items["issue:7"].paused = true; return s; });
  f.api.events = async () => [...await old(), { id: 124, event: "labeled", created_at: at,
    actor: { login: "ntodd" }, label: { name: "agent-ready" } }];
  await f.pass({ operationId: () => "op-2" });
  assert.equal(f.state.items["issue:7"].paused, false);
  assert.equal(f.state.operations["op-2"].mode, "respond");
  assert.equal(f.state.operations["op-2"].target.number, 9);
  assert.deepEqual(f.state.items["issue:7"].prs.map((p) => p.number), [9]);
  await f.pass({ operationId: () => { throw new Error("Relabel was replayed"); } });
  assert.equal(Object.keys(f.state.operations).length, 2);
});

test("a first issue mention is routed, admitted from its fresh source, then dispatched exactly once", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  const rows = [{ id: 999, body: "@ntodd-agent implement this", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  f.api.comments = async (n) => n === 7 ? rows : [];
  let calls = 0;
  const route = async (_command, item) => {
    calls++; assert.equal(item.requestOnly, true); assert.equal(item.activeOperation, null);
    return { action: "build", effort: null };
  };
  await f.pass({ route }); await f.pass({ route });
  assert.equal(calls, 1);
  assert.equal(f.state.items["issue:7"].requestOnly, false);
  assert.equal(f.state.items["issue:7"].evidence.kind, "routed-command");
  assert.equal(f.state.items["issue:7"].evidence.action, "build");
  assert.equal(f.state.operations["op-1"].mode, "build");
  assert.equal(f.effects.filter(([kind]) => kind === "dispatch").length, 1);
  assert.equal((await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "issue:7", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main" } })).claimed, true);
});

test("a status mention cannot silently admit coding, and a later exact build can authorize the same request record", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  const rows = [{ id: 999, body: "@ntodd-agent status", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  f.api.comments = async () => rows;
  await f.pass({ route: async () => ({ action: "status", effort: null }) }); await f.pass();
  assert.equal(f.state.items["issue:7"].requestOnly, true);
  assert.deepEqual(f.state.operations, {}); assert.deepEqual(f.effects, []);
  rows.shift();
  rows.push({ id: 1000, body: "/agent build keep the public API", user: { login: "ntodd" }, created_at: at, updated_at: at });
  await f.pass();
  assert.equal(f.state.items["issue:7"].evidence.sourceId, "issue-comment:1000");
  assert.equal(f.state.items["issue:7"].requestOnly, false);
  assert.equal(f.state.operations["op-1"].mode, "build");
});

test("changing an initial mention during routing prevents admission and spends no coding attempt", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  const row = { id: 999, body: "@ntodd-agent build this", user: { login: "ntodd" }, created_at: at, updated_at: at };
  f.api.comments = async () => [row];
  await f.pass({ route: async () => { row.updated_at = "2026-11-12T12:01:00Z"; return { action: "build", effort: null }; } });
  assert.equal(f.state.items["issue:7"].requestOnly, true);
  assert.deepEqual(f.state.items["issue:7"].attempts, []);
  assert.deepEqual(f.state.operations, {}); assert.deepEqual(f.effects, []);
});

test("a first review-thread mention authorizes only requested maintenance on a person's PR", async () => {
  const f = fixture();
  const pr = { number: 9, title: "My fix", body: "Intent", state: "open", user: { login: "ntodd" },
    head: { sha: B, ref: "my-fix", repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
  const rows = [{ id: 999, body: "@ntodd-agent bring this up to date", author: "ntodd", lastEditedAt: null, createdAt: at, updatedAt: at }];
  f.api.openIssues = async () => []; f.api.openPulls = async () => [pr]; f.api.pull = async () => pr;
  f.api.branchSha = async (ref) => ref === "main" ? A : B;
  f.api.threads = async () => [{ id: "T1", isResolved: false, comments: rows }];
  await f.pass({ route: async (command, item) => {
    assert.equal(command.thread, "T1"); assert.equal(item.evidence.own, true);
    return { action: "update", effort: null };
  } });
  assert.equal(f.state.items["pr:9"].requestOnly, false);
  assert.equal(f.state.items["pr:9"].evidence.sourceId, "review-comment:999");
  assert.equal(f.state.operations["op-1"].mode, "update");
  assert.deepEqual(f.state.operations["op-1"].threadTargets, []);
  assert.equal((await claimOperation({ api: f.api, store: f.store, repo: "ntodd/project", itemKey: "pr:9", operationId: "op-1", run,
    context: { sha: A, defaultBranch: "main" } })).claimed, true);
});

test("own-PR readmission requires a new maintenance source and preserves the person's PR", async () => {
  const f = fixture();
  const pr = { number: 9, title: "My fix", body: "Intent", state: "open", user: { login: "ntodd" },
    head: { sha: B, ref: "my-fix", repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
  const rows = [{ id: 999, body: "/agent update", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  f.api.openIssues = async () => []; f.api.openPulls = async () => [pr]; f.api.pull = async () => pr;
  f.api.branchSha = async (ref) => ref === "main" ? A : B; f.api.comments = async () => rows;
  await f.pass(); rows.shift(); await f.pass();
  assert.equal(f.state.items["pr:9"].authorizationRevoked, true);
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  rows.push({ id: 1001, body: "/agent resolve", user: { login: "ntodd" }, created_at: at, updated_at: at });
  await f.pass({ operationId: () => "op-2" });
  assert.equal(f.state.items["pr:9"].authorizationRevoked, undefined);
  assert.equal(f.state.items["pr:9"].evidence.sourceId, "issue-comment:1001");
  assert.equal(f.state.operations["op-2"].mode, "resolve");
  assert.equal(f.state.operations["op-2"].target.branch, "my-fix");
  assert.equal(f.state.items["pr:9"].attempts.length, 2);
  assert.equal(pr.body, "Intent");
  assert.equal(f.effects.some(([kind]) => ["close", "push", "pull-request"].includes(kind)), false);
});

test("an untrusted edit between routing and initial admission is rejected before any coding reservation", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  const row = { id: 999, body: "@ntodd-agent build this", user: { login: "ntodd" }, created_at: at, updated_at: at };
  f.api.comments = async () => [row];
  await f.pass({ route: async () => { f.api.editors = async () => ["outsider"]; return { action: "build", effort: null }; } });
  assert.equal(f.state.items["issue:7"].requestOnly, true);
  assert.match(f.state.items["issue:7"].question.reason, /untrusted actor/);
  assert.deepEqual(f.state.operations, {}); assert.deepEqual(f.effects, []);
});

test("read-only discovery reports a first mention without ledger writes or a model call", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  f.api.comments = async () => [{ id: 999, body: "@ntodd-agent build this", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  const result = await f.pass({ dryRun: true, route: async () => { throw new Error("Read-only discovery called the model"); } });
  assert.deepEqual(result.admissions, [{ key: "issue:7", requestOnly: true, sourceId: "issue-comment:999" }]);
  assert.equal(result.plans[0].action.type, "route");
  assert.deepEqual(f.state.items, {}); assert.deepEqual(f.effects, []);
});

test("one failed discovery candidate cannot hide other new work", async () => {
  const f = fixture(), second = { ...f.source, number: 8 };
  f.api.openIssues = async () => [f.source, second];
  f.api.issue = async (n) => n === 7 ? f.source : second;
  f.api.editors = async (n) => { if (n === 7) throw new Error("Edit history unavailable"); return []; };
  const result = await f.pass();
  assert.equal(f.state.items["issue:7"], undefined);
  assert.equal(f.state.operations["op-1"].item, "issue:8");
  assert.ok(result.outcomes.some((o) => o.action === "discover" && o.target === 7 && o.status === "interrupted"));
});

test("a stop mention is still routed when discovery and required-check APIs are unavailable", async () => {
  const f = fixture(); await f.pass();
  f.api.openIssues = async () => { throw new Error("Discovery API unavailable"); };
  f.api.branchRules = async () => { throw new Error("Rules API unavailable"); };
  f.api.comments = async () => [{ id: 999, body: "@ntodd-agent stop", user: { login: "ntodd" }, created_at: at, updated_at: at }];
  await f.pass({ route: async () => ({ action: "stop", effort: null }) });
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.equal(f.state.operations["op-1"].phase, "superseded");
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
});

test("exact initial status/effort/stop requests are acknowledged controls, never implicit coding permission", async () => {
  const f = fixture(); f.source.labels = []; f.api.events = async () => [];
  f.api.comments = async () => ["/effort high", "/agent status", "/agent stop"].map((body, i) => ({ id: 999 + i,
    body, user: { login: "ntodd" }, created_at: at, updated_at: at }));
  await f.pass({ route: async () => { throw new Error("Exact controls called the router"); } });
  assert.equal(f.state.items["issue:7"].requestOnly, true);
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.equal(f.state.items["issue:7"].effort, "high");
  assert.deepEqual(f.state.operations, {}); assert.deepEqual(f.effects, []);
});
