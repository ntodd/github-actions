import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceService, projectItem } from "../lib/surfaces.mjs";
import { validateLedger, evolve } from "../lib/protocol.mjs";
import { ingestCommands, applyControls, resolveRoute } from "../lib/commands.mjs";
import { classifyText, classifyLabel } from "../lib/admission.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, pending, A, B, C, at, run } from "./fixtures.mjs";

function fixture() {
  let state = initial(), id = 1000, clock = at, issueState = "open";
  state.items["issue:7"].prs.pop();
  state.items["issue:7"].evidence.actor = "ntodd";
  state.items["issue:7"].status = { state: "agent-review", reason: "Checks passed", next: "handover", wait: null };
  const config = parseConfig("trusted-users: [ntodd]"), context = { config, repo: "ntodd/project", defaultBranch: "main", repositoryId: "42", sha: A };
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const rows = new Map([[7, []], [9, []]]), labels = new Map([[7, ["bug"]], [9, ["bug"]]]), reactions = [], writes = [], stateEvents = [];
  const pr = { number: 9, node_id: "PR_9", state: "open", draft: true, user: { login: "ntodd-agent[bot]" },
    head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { sha: A, ref: "main" }, requested_reviewers: [] };
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }), branchSha: async () => A,
    fileAt: async () => ({ content: "trusted-users: [ntodd]" }),
    issue: async (n) => ({ number: n, state: n === 7 ? issueState : pr.state, title: "Fix it", body: "Accepted task", user: { login: "ntodd" }, labels: labels.get(n).map((name) => ({ name })) }),
    pull: async () => pr, comments: async (n) => rows.get(n), editors: async () => [],
    events: async () => [{ id: 123, event: "labeled", created_at: "2026-11-12T00:00:00Z", actor: { login: "ntodd" }, label: { name: "agent-ready" } }, ...stateEvents],
    reviews: async () => [], threads: async () => [],
    branchRules: async () => [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }],
    compare: async () => ({ behind_by: 0 }),
    pullStatus: async () => ({ headRefOid: B, baseRefOid: A, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" }),
    checks: async (sha) => ({ sha, statuses: [], checkRuns: [{ id: 1, head_sha: sha, name: "CI", app: { id: 1 }, status: "completed", conclusion: "success" }] }),
  };
  const write = {
    comments: async (n) => rows.get(n),
    comment: async (n, body) => { writes.push(["comment", n]); const row = { id: id++, body, user: { login: "ntodd-agent[bot]" },
      issue_url: `https://api.github.com/repos/ntodd/project/issues/${n}`, created_at: at, updated_at: at }; rows.get(n).push(row); return row; },
    commentById: async (_kind, value) => {
      const found = [...rows.values()].flat().find((r) => r.id === value);
      if (!found) throw Object.assign(new Error("missing comment"), { status: 404 }); return found;
    },
    editComment: async (value, body) => { writes.push(["edit", value]); const row = await write.commentById("issue-comment", value); row.body = body; return row; },
    reactions: async () => reactions,
    react: async (_kind, _id, content) => { writes.push(["reaction"]); const r = { id: id++, content, user: { login: "ntodd-agent[bot]" } }; reactions.push(r); return r; },
    addLabels: async (n, names) => { writes.push(["labels-add", n]); labels.set(n, [...new Set([...labels.get(n), ...names])]); },
    removeLabel: async (n, label) => { writes.push(["label-remove", n]); labels.set(n, labels.get(n).filter((v) => v !== label)); },
    ready: async () => { writes.push(["ready"]); pr.draft = false; return { number: 9, headRefOid: pr.head.sha, isDraft: false }; },
    requestReviewers: async (_n, reviewers) => { writes.push(["review"]); pr.requested_reviewers = reviewers.map((login) => ({ login })); },
    closeIssue: async () => { writes.push(["issue-close"]); issueState = "closed";
      stateEvents.push({ id: id++, event: "closed", created_at: clock, actor: { login: "ntodd-agent[bot]" } }); },
  };
  const service = (extra = {}) => surfaceService({ api, write, store, repo: context.repo, appLogin: "ntodd-agent[bot]", run, now: () => clock, ...extra });
  return { api, write, store, rows, labels, writes, pr, config, context, service, get state() { return state; },
    tick(value = "2026-11-12T12:05:00Z") { clock = value; },
    async command(body) {
      const row = { id: id++, body, user: { login: "ntodd" }, created_at: at, updated_at: at };
      rows.get(9).push(row);
      await store.transact((s) => applyControls(ingestCommands(s, "issue:7", [classifyText(row, "issue-comment", config, { target: 9 })]), "issue:7"));
      return Object.values(state.items["issue:7"].commands).at(-1);
    } };
}

test("status is edited in place and factory label repair preserves unrelated human labels", async () => {
  const f = fixture(), service = f.service();
  await service.render(f.state, f.context); await service.render(f.state, f.context);
  assert.equal(f.writes.filter(([kind]) => kind === "comment").length, 2);
  assert.deepEqual(f.labels.get(9).sort(), ["agent-review", "bug"]);
  f.labels.get(9).push("manual");
  await f.store.transact((s) => evolve(s, "issue:7", { type: "set-status", status: { state: "agent-waiting", reason: "Waiting for CI", next: "ci" } }));
  f.tick(); await service.render(f.state, f.context);
  assert.equal(f.writes.filter(([kind]) => kind === "comment").length, 2);
  assert.deepEqual(f.labels.get(9).sort(), ["agent-waiting", "bug", "manual"]);
  assert.match(f.rows.get(9)[0].body, /Waiting for CI/);
});

test("label inventory failures produce one durable observation notice and recover it in place", async () => {
  const f = fixture(), service = f.service(), issue = f.api.issue;
  await service.render(f.state, f.context); let reads = 0;
  f.api.issue = async (n) => { if (n === 9) { reads++; throw Object.assign(new Error("private read detail"), { status: 403 }); } return issue(n); };
  for (const time of [at, "2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z"]) { f.tick(time); await service.render(f.state, f.context); }
  const alerts = Object.values(f.state.items["issue:7"].apiAlerts);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].source, "preflight"); assert.equal(alerts[0].kind, "labels");
  assert.equal(alerts[0].request, undefined); assert.equal(f.state.items["issue:7"].question, null);
  const notice = f.rows.get(9).find((r) => r.body.includes("factory:attention="));
  assert.match(notice.body, /Observation:/); assert.doesNotMatch(notice.body, /Request:|undefined|private read detail/);
  f.tick("2026-11-12T12:04:00Z"); await service.render(f.state, f.context); assert.equal(reads, 3);
  f.api.issue = issue; f.tick("2026-11-12T12:07:00Z"); await service.render(f.state, f.context);
  assert.equal(f.state.items["issue:7"].apiAlerts[alerts[0].id].resolution, "observed");
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:attention=")).length, 1);
  assert.match(f.rows.get(9).find((r) => r.id === notice.id).body, /Recovered/);
  assert.equal(f.state.items["issue:7"].attempts.length, 0);
});

test("a failed status lookup still permits label repair and cannot recursively notify about notifications", async () => {
  const f = fixture(), service = f.service(), comments = f.write.comments;
  f.write.comments = async (n) => { if (n === 9) throw Object.assign(new Error("comments unavailable"), { status: 503 }); return comments(n); };
  for (const time of [at, "2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z", "2026-11-12T12:04:00Z"]) {
    f.tick(time); await service.render(f.state, f.context);
  }
  assert.deepEqual(f.labels.get(9).sort(), ["agent-review", "bug"]);
  const item = f.state.items["issue:7"], alerts = Object.values(item.apiAlerts);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].kind, "status"); assert.equal(alerts[0].source, "preflight");
  assert.ok(Object.values(item.preflights).some((r) => r.kind === "notification"));
  assert.equal(Object.values(item.preflights).find((r) => r.kind === "status").failures, 3);
  assert.ok(Object.values(item.apiEffects).filter((e) => e.definition.kind === "comment-create" && e.definition.target === 9)
    .every((e) => e.requests.length === 0));
  assert.equal(item.question, null);
  f.write.comments = comments; f.tick("2026-11-12T12:07:00Z"); await service.render(f.state, f.context);
  assert.equal(f.state.items["issue:7"].apiAlerts[alerts[0].id].resolution, "observed");
});

test("handover read failures escalate before an intent exists and settle after a known stop", async () => {
  const f = fixture(), service = f.service(); let reads = 0;
  f.api.pull = async () => { reads++; throw Object.assign(new Error("PR unavailable"), { status: 403 }); };
  const args = { key: "issue:7", number: 9, head: B, context: f.context };
  await assert.rejects(service.handover(args));
  await assert.rejects(service.handover(args), (e) => e.code === "preflight-wait"); assert.equal(reads, 1);
  for (const time of ["2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z"]) { f.tick(time); await assert.rejects(service.handover(args)); }
  assert.equal(f.state.items["issue:7"].apiEffects, undefined);
  await service.render(f.state, f.context);
  const alert = Object.values(f.state.items["issue:7"].apiAlerts)[0];
  assert.equal(alert.kind, "ready"); assert.equal(alert.source, "preflight");
  assert.equal(f.writes.some(([kind]) => kind === "ready" || kind === "review"), false);
  await f.store.transact((s) => evolve(s, "issue:7", { type: "stop" }));
  await service.render(f.state, f.context);
  assert.equal(f.state.items["issue:7"].apiAlerts[alert.id].resolution, "superseded");
});

test("a runtime conflict before surface submission leaves an unsent intent without an uncertain request", async () => {
  const f = fixture(), outcomes = [];
  await f.service({ assertRuntime: async () => { throw new Error("Legacy runtime conflict"); } }).render(f.state, f.context, outcomes);
  assert.deepEqual(f.writes, []);
  assert.ok(Object.values(f.state.items["issue:7"].apiEffects).every((e) => e.requests.length === 0 && e.status === "prepared"));
  assert.ok(outcomes.some((o) => o.reason === "Legacy runtime conflict"));
});

test("a trusted label gets one acknowledgement without trying to react to a timeline event", async () => {
  const f = fixture(), originalEvents = f.api.events;
  const event = { id: 124, event: "labeled", created_at: at, actor: { login: "ntodd" }, label: { name: "effort:high" } };
  f.api.events = async () => [...await originalEvents(), event];
  await f.store.transact((s) => applyControls(ingestCommands(s, "issue:7", [classifyLabel(event, f.config, 7)]), "issue:7"));
  const service = f.service();
  await service.acknowledge(); await service.acknowledge();
  assert.equal(f.writes.filter(([kind]) => kind === "reaction").length, 0);
  assert.equal(f.writes.filter(([kind]) => kind === "comment").length, 1);
  assert.match(f.rows.get(7)[0].body, /Using high effort/);
  assert.equal(Object.values(f.state.items["issue:7"].commands)[0].acknowledgement, "done");
});

test("a lost status-create response is recovered and never creates another status comment", async () => {
  const f = fixture(), original = f.write.comment; let once = true;
  f.write.comment = async (...args) => { const result = await original(...args); if (once) { once = false; throw new Error("response lost"); } return result; };
  const service = f.service(); await service.render(f.state, f.context); await service.render(f.state, f.context);
  assert.equal(f.writes.filter(([kind]) => kind === "comment").length, 2);
  assert.ok(Object.values(f.state.items["issue:7"].apiEffects).filter((e) => e.definition.kind === "comment-create").every((e) => e.status === "applied"));
});

test("only confirmed deletion of a previously created status permits a replacement", async () => {
  const f = fixture(), service = f.service(); await service.render(f.state, f.context);
  f.rows.set(9, []); await service.render(f.state, f.context); await service.render(f.state, f.context);
  assert.equal(f.writes.filter(([kind, n]) => kind === "comment" && n === 9).length, 2);
});

test("failed status receipt reads back off and recover from a subsequent authoritative inventory", async () => {
  const f = fixture(), service = f.service(), comments = f.write.comments, byId = f.write.commentById; let reads = 0;
  f.write.comments = async (n) => n === 9 ? [] : comments(n);
  f.write.commentById = async (kind, id) => {
    if (f.rows.get(9).some((r) => r.id === id && r.body.includes("factory:status="))) {
      reads++; throw Object.assign(new Error("comment read unavailable"), { status: 503 });
    }
    return byId(kind, id);
  };
  for (const time of [at, "2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z", "2026-11-12T12:04:00Z"]) {
    f.tick(time); await service.render(f.state, f.context);
  }
  const alert = Object.values(f.state.items["issue:7"].apiAlerts)[0];
  assert.equal(reads, 3); assert.equal(alert.kind, "status"); assert.equal(alert.source, "preflight");
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:status=")).length, 1);
  f.write.comments = comments; f.tick("2026-11-12T12:07:00Z"); await service.render(f.state, f.context);
  assert.equal(f.state.items["issue:7"].apiAlerts[alert.id].resolution, "observed");
  assert.equal(Object.values(f.state.items["issue:7"].preflights).find((r) => r.kind === "status").status, "observed");
});

test("mentions get eyes immediately and a single action acknowledgement after routing", async () => {
  const f = fixture(), command = await f.command("@ntodd-agent rebase this"), service = f.service();
  await service.acknowledge();
  assert.equal(f.writes.filter(([kind]) => kind === "reaction").length, 1);
  assert.equal(f.writes.filter(([kind]) => kind === "comment").length, 0);
  await f.store.transact((s) => resolveRoute(s, "issue:7", command.id, "update"));
  await service.acknowledge(); await service.acknowledge();
  assert.equal(f.writes.filter(([kind]) => kind === "comment").length, 1);
  assert.equal(f.state.items["issue:7"].commands[command.id].acknowledgement, "done");
  assert.match(f.rows.get(9).at(-1).body, /with a merge/);
});

test("edited or deleted commands cannot cause acknowledgements", async () => {
  const f = fixture(); await f.command("/agent resolve"); f.rows.get(9)[0].body = "Changed";
  await f.service().acknowledge(); assert.equal(f.writes.length, 0);
});

test("a stop acknowledgement lists the exact in-flight writes without resuming publication", async () => {
  const f = fixture();
  await f.store.transact(() => { const state = pending(); state.items["issue:7"].prs.pop(); return state; });
  await f.command("/agent stop"); await f.service().acknowledge();
  const reply = f.rows.get(9).find((r) => r.body.includes("factory:ack="));
  assert.match(reply.body, /Work is paused/); assert.match(reply.body, /op-1\/push\/1/);
  assert.equal(f.state.operations["op-1"].phase, "publishing");
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.equal(projectItem(f.state, "issue:7").find((p) => p.target === 9).status.state, "agent-stopped");
});

test("an unresolved surface request notifies once without blocking code and is edited after recovery", async () => {
  const f = fixture(), service = f.service(), original = f.write.comment;
  const marker = "<!-- factory:notice=unresolved -->", body = `Public request\n${marker}`;
  let requests = 0;
  f.write.comment = async (n, text) => {
    if (text.includes(marker)) { requests++; throw new Error("Response unknown"); }
    return original(n, text);
  };
  await service.execute("issue:7", "external-notice", { kind: "comment-create", target: 9, payload: { marker, body } });
  f.tick("2026-11-12T12:16:00Z"); await service.render(f.state, f.context); await service.render(f.state, f.context);
  const alerts = Object.values(f.state.items["issue:7"].apiAlerts);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].status, "active");
  assert.equal(f.state.items["issue:7"].question, null);
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:attention=")).length, 1);
  assert.equal(requests, 1);
  f.rows.get(9).push({ id: 2000, body, user: { login: "ntodd-agent[bot]" }, issue_url: "https://api.github.com/repos/ntodd/project/issues/9", created_at: at, updated_at: at });
  f.tick("2026-11-12T12:17:00Z"); await service.render(f.state, f.context);
  assert.equal(f.state.items["issue:7"].apiAlerts[alerts[0].id].status, "resolved");
  assert.match(f.rows.get(9).find((r) => r.body.includes("factory:attention=")).body, /Recovered/);
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:attention=")).length, 1);
});

test("questions notify once per occurrence and request review while preserving the draft state", async () => {
  const f = fixture(), service = f.service();
  await f.store.transact((s) => evolve(s, "issue:7", { type: "ask", reason: "Choose one of these options" }));
  const first = f.state.items["issue:7"].question.id;
  await service.render(f.state, f.context); await service.render(f.state, f.context);
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:question=")).length, 1);
  assert.equal(f.writes.filter(([kind]) => kind === "review").length, 1);
  assert.equal(f.pr.draft, true);
  await f.store.transact((s) => evolve(evolve(s, "issue:7", { type: "resume", answerSource: "issue-comment:1" }), "issue:7", { type: "ask", reason: "Choose one of these options" }));
  assert.notEqual(f.state.items["issue:7"].question.id, first);
  await service.render(f.state, f.context);
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:question=")).length, 2);
});

test("question review preflights back off without creating an attention loop", async () => {
  const f = fixture(), service = f.service(), pull = f.api.pull; let reads = 0;
  await f.store.transact((s) => evolve(s, "issue:7", { type: "ask", reason: "Choose one of these options" }));
  f.api.pull = async () => { reads++; throw Object.assign(new Error("PR read unavailable"), { status: 503 }); };
  for (const time of [at, "2026-11-12T12:01:00Z", "2026-11-12T12:03:00Z", "2026-11-12T12:04:00Z"]) {
    f.tick(time); await service.render(f.state, f.context);
  }
  assert.equal(reads, 3); assert.equal(f.state.items["issue:7"].apiAlerts, undefined);
  assert.equal(f.rows.get(9).filter((r) => r.body.includes("factory:question=")).length, 1);
  assert.equal(f.writes.filter(([kind]) => kind === "review").length, 0);
  f.api.pull = pull; f.tick("2026-11-12T12:07:00Z"); await service.render(f.state, f.context);
  assert.equal(f.writes.filter(([kind]) => kind === "review").length, 1);
  assert.ok(Object.values(f.state.items["issue:7"].preflights).every((r) => r.status === "observed"));
});

test("closure questions stay on the affected PR and their acknowledgement names the accepted disposition", async () => {
  const f = fixture();
  f.pr.state = "closed"; f.rows.set(10, []); f.labels.set(10, []);
  f.api.pull = async (number) => number === 10 ? { ...f.pr, number: 10, state: "open" } : f.pr;
  await f.store.transact((s) => {
    s.items["issue:7"].prs.push({ number: 10, required: true, state: "open", mergedSha: null, acceptedClosure: false });
    s = evolve(s, "issue:7", { type: "pr-observed", number: 9, state: "closed" });
    return evolve(s, "issue:7", { type: "ask", kind: "pr-closure", number: 9, reason: "Accept the closure of #9?", at });
  });
  await f.service().render(f.state, f.context);
  assert.equal(f.rows.get(9).filter((row) => row.body.includes("factory:question=")).length, 1);
  assert.equal(f.rows.get(10).filter((row) => row.body.includes("factory:question=")).length, 0);
  assert.equal(f.writes.filter(([kind]) => kind === "review").length, 0);
  const command = await f.command("/agent answer accept-closure #9");
  await f.store.transact((s) => evolve(s, "issue:7", { type: "accept-closure", number: 9, commandId: command.id,
    authorization: { valid: true, revision: s.items["issue:7"].revision }, at }));
  await f.service().acknowledge();
  assert.match(f.rows.get(9).find((row) => row.body.includes(`factory:ack=${command.id}`)).body, /closure of PR #9 is accepted/);
  assert.equal(f.state.items["issue:7"].complete, false);
});

test("handover marks an agent PR ready and requests review once, while an own PR's metadata stays unchanged", async () => {
  const f = fixture(), service = f.service(), args = { key: "issue:7", number: 9, head: B, context: f.context };
  assert.equal((await service.handover(args)).status, "applied");
  assert.equal((await service.handover(args)).status, "applied");
  assert.deepEqual(f.writes.map(([kind]) => kind), ["ready", "review"]);
  const own = fixture();
  await own.store.transact((s) => { s.items["issue:7"].evidence.own = true; return s; });
  await own.service().handover({ ...args, context: own.context });
  assert.equal(own.writes.length, 0); assert.equal(own.pr.draft, true);
});

test("handover revalidates CI even if a previously-ready PR already satisfies the metadata effect", async () => {
  const f = fixture(), service = f.service(), args = { key: "issue:7", number: 9, head: B, context: f.context };
  await service.handover(args); f.writes.length = 0; f.pr.requested_reviewers = [];
  f.api.checks = async (sha) => ({ sha, statuses: [], checkRuns: [{ id: 1, head_sha: sha, name: "CI", app: { id: 1 }, status: "completed", conclusion: "failure" }] });
  assert.equal((await service.handover(args)).status, "superseded"); assert.equal(f.writes.length, 0);
});

test("a partial issue shows terminal PRs independently and escapes hidden-state terminators", async () => {
  const f = fixture();
  await f.store.transact((s) => {
    s.items["issue:7"].prs.push({ number: 10, required: true, state: "merged", mergedSha: C, acceptedClosure: false });
    s.items["issue:7"].status.reason = "Wait --> on dependency"; return s;
  });
  const projections = projectItem(f.state, "issue:7");
  assert.equal(projections.find((p) => p.target === 10).status.state, "agent-complete");
  assert.equal(projections.find((p) => p.target === 9).status.state, "agent-review");
  const json = /<!-- agent-ready:state (.*) -->/.exec(projections[0].body)[1];
  assert.equal(JSON.parse(json).reason, "Wait --> on dependency");
  assert.ok(!json.includes("-->"));
});

test("close-out recovers a lost issue-close response after revalidating every recorded outcome", async () => {
  const f = fixture(); f.pr.state = "closed"; f.pr.merged_at = at; f.pr.merge_commit_sha = C;
  await f.store.transact((s) => evolve(evolve(s, "issue:7", { type: "pr-observed", number: 9, state: "merged", mergedSha: C }), "issue:7", { type: "close-out" }));
  const original = f.write.closeIssue;
  f.write.closeIssue = async () => { await original(); throw new Error("response lost"); };
  const service = f.service();
  assert.equal((await service.closeOut({ key: "issue:7" })).status, "pending");
  assert.equal((await service.closeOut({ key: "issue:7" })).status, "applied");
  assert.equal(f.writes.filter(([kind]) => kind === "issue-close").length, 1);
});

test("close-out cannot rely on an old ledger's terminal claim or revoked authority", async () => {
  for (const revoked of [false, true]) {
    const f = fixture(); f.pr.state = "closed"; f.pr.merged_at = at; f.pr.merge_commit_sha = C;
    await f.store.transact((s) => evolve(evolve(s, "issue:7", { type: "pr-observed", number: 9, state: "merged", mergedSha: C }), "issue:7", { type: "close-out" }));
    if (revoked) f.api.fileAt = async () => ({ content: "trusted-users: [someone-else]" });
    else f.pr.merge_commit_sha = A;
    assert.equal((await f.service().closeOut({ key: "issue:7" })).status, "superseded");
    assert.equal(f.writes.length, 0);
  }
});

test("an identified CI rerun is bound to its original run/commit and recovers a lost response without another rerun", async () => {
  const f = fixture(), ci = { id: 123, run_attempt: 1, status: "completed", head_sha: B, repository: { id: 42 }, head_repository: { id: 42 }, path: ".github/workflows/ci.yml" };
  f.api.run = async () => ci;
  f.write.rerunFailedJobs = async () => { f.writes.push(["rerun"]); ci.run_attempt++; ci.status = "queued"; throw new Error("response lost"); };
  const service = f.service(), args = { key: "issue:7", number: 9, head: B, testedSha: B, runIds: [123], context: f.context };
  const first = (await service.rerunCi(args))[0];
  assert.equal(first.status, "pending");
  assert.equal((await service.recoverCi({ key: "issue:7", effectId: first.id })).status, "applied");
  await service.rerunCi(args);
  assert.equal(f.writes.filter(([kind]) => kind === "rerun").length, 1);
  assert.equal(first.definition.payload.attempt, 1);
});

test("a foreign, factory or old-integration run cannot become a CI rerun effect", async () => {
  for (const changed of [{ head_sha: A }, { head_repository: { id: 99 } }, { path: ".github/workflows/factory.yml" }]) {
    const f = fixture();
    f.api.run = async () => ({ id: 123, run_attempt: 1, head_sha: B, repository: { id: 42 }, head_repository: { id: 42 }, path: ".github/workflows/ci.yml", ...changed });
    await assert.rejects(() => f.service().rerunCi({ key: "issue:7", number: 9, head: B, testedSha: B, runIds: [123], context: f.context }), /recorded current-head/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.state.items["issue:7"].apiEffects, undefined);
  }
});
