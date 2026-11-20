import { test } from "node:test";
import assert from "node:assert/strict";
import { continueService } from "../lib/continue.mjs";
import { surfaceService } from "../lib/surfaces.mjs";
import { runController } from "../lib/controller.mjs";
import { ingestCommands, applyControls } from "../lib/commands.mjs";
import { classifyText } from "../lib/admission.mjs";
import { parseConfig } from "../lib/config.mjs";
import { evolve, validateLedger } from "../lib/protocol.mjs";
import { initial, claimed, A, B, C, at, run } from "./fixtures.mjs";

function fixture({ live = false } = {}) {
  let state = live ? claimed() : initial(), issueState = "closed", clock = "2026-11-12T12:02:00Z", id = 1000;
  state.items["issue:7"].prs.pop();
  state = evolve(state, "issue:7", { type: "ask", kind: "issue-closure", reason: "Stop or continue the early-closed issue?", at });
  const config = parseConfig("trusted-users: [ntodd]"), comments = [], events = [{ id: 123, event: "labeled",
    created_at: "2026-11-12T00:00:00Z", actor: { login: "ntodd" }, label: { name: "agent-ready" } }], writes = [];
  const pr = { number: 9, state: "open", user: { login: "ntodd-agent[bot]" },
    head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }), fileAt: async () => ({ content: "trusted-users: [ntodd]" }),
    branchSha: async (ref) => ref === "main" ? A : B,
    issue: async () => ({ number: 7, title: "Fix it", body: "Accepted task", state: issueState, user: { login: "ntodd" }, labels: [] }),
    pull: async () => pr, comments: async (number) => number === 7 ? comments : [], events: async () => events,
    editors: async () => [], reviews: async () => [], threads: async () => [], compare: async () => ({ behind_by: 0 }),
    branchRules: async () => [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI", integration_id: 1 }] } }],
    pullStatus: async () => ({ headRefOid: B, baseRefOid: A, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" }),
    checks: async (sha) => ({ sha, statuses: [], checkRuns: [{ id: 1, head_sha: sha, name: "CI", app: { id: 1 }, status: "completed", conclusion: "success" }] }),
  };
  const write = {
    reopenIssue: async () => { writes.push(["reopen"]); issueState = "open";
      events.push({ id: id++, event: "reopened", actor: { login: "ntodd-agent[bot]" }, created_at: clock }); },
    dispatch: async () => writes.push(["dispatch"]), cancelRun: async () => writes.push(["cancel"]),
    closeIssue: async () => { writes.push(["close"]); issueState = "closed"; },
  };
  const effects = surfaceService({ api, write, store, repo: "ntodd/project", appLogin: "ntodd-agent[bot]", run: { id: "900", attempt: 1 }, now: () => clock });
  const continueIssue = continueService({ api, store, effects, now: () => clock });
  const pass = (extra = {}) => runController({ api, write, store, repo: "ntodd/project", toolingSha: A,
    run: { id: "900", attempt: 1 }, now: () => clock, discovery: false, maxPasses: 1, continueIssue,
    actions: { inspect: async () => ({ owner: { ...run, status: "in_progress", conclusion: null }, inspected: false, available: false }) }, ...extra });
  const command = async (body, { author = "ntodd", when = "2026-11-12T12:01:00Z" } = {}) => {
    const row = { id: id++, body, user: { login: author }, created_at: when, updated_at: when }; comments.push(row);
    await store.transact((s) => applyControls(ingestCommands(s, "issue:7", [classifyText(row, "issue-comment", config, { target: 7 })]), "issue:7", { now: clock }));
    return row;
  };
  return { api, store, write, writes, events, pr, pass, command, get state() { return state; }, get issueState() { return issueState; },
    set issueState(value) { issueState = value; }, tick(value) { clock = value; } };
}

test("a public continue answer reopens the issue and retains its claimed worker, PR and budget", async () => {
  const f = fixture({ live: true }); await f.command("/agent answer continue");
  await f.pass();
  assert.equal(f.issueState, "open"); assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  assert.equal(f.state.items["issue:7"].activeOperation, "op-1");
  assert.equal(f.state.items["issue:7"].attempts.length, 1);
  assert.deepEqual(f.state.operations["op-1"].owner.id, run.id);
  await f.pass();
  assert.deepEqual(f.writes, [["reopen"]]);
  assert.equal(f.state.items["issue:7"].status.state, "agent-working");
});

test("a routed mention can answer the current issue question with the documented numbered reply", async () => {
  const f = fixture(); await f.command("@ntodd-agent go with 1");
  let routes = 0;
  await f.pass({ maxPasses: 4, route: async () => { routes++; return { action: "answer", effort: null }; } });
  assert.equal(routes, 1);
  assert.equal(f.issueState, "open"); assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  const command = Object.values(f.state.items["issue:7"].commands)[0];
  assert.equal(command.text, "@ntodd-agent go with 1");
  assert.equal(command.routedHandle, "ntodd-agent");
  assert.deepEqual(f.writes, [["reopen"]]);
});

test("a lost reopen response is recovered from its App event without another request or worker", async () => {
  const f = fixture(), reopen = f.write.reopenIssue; await f.command("/agent answer 1");
  f.write.reopenIssue = async () => { await reopen(); throw new Error("response lost"); };
  await f.pass();
  assert.equal(f.state.items["issue:7"].continuation.phase, "requested");
  await f.pass(); await f.pass();
  const item = f.state.items["issue:7"], effect = Object.values(item.apiEffects).find((e) => e.definition.kind === "issue-reopen");
  assert.equal(item.continuation.phase, "done"); assert.equal(item.attempts.length, 0);
  assert.equal(effect.requests.length, 1); assert.equal(effect.receipt.proof, "timeline");
  assert.deepEqual(f.writes, [["reopen"]]);
});

test("a human reopening alone cannot settle an uncertain App request, even after its deadline", async () => {
  const f = fixture(); await f.command("/agent answer continue");
  f.write.reopenIssue = async () => { f.writes.push(["reopen"]); throw new Error("outcome unknown"); };
  await f.pass(); f.issueState = "open";
  f.events.push({ id: 2000, event: "reopened", actor: { login: "ntodd" }, created_at: "2026-11-12T12:03:00Z" });
  f.tick("2026-11-13T12:05:00Z"); await f.pass(); await f.pass();
  const item = f.state.items["issue:7"];
  assert.equal(item.continuation.phase, "requested");
  assert.equal(Object.values(item.apiEffects).find((e) => e.definition.kind === "issue-reopen").status, "pending");
  assert.equal(Object.values(item.apiAlerts).filter((a) => a.status === "active").length, 1);
  assert.deepEqual(f.writes, [["reopen"]]); assert.equal(item.attempts.length, 0);
});

test("a late reopen receipt after stop is recorded without resuming or replacing work", async () => {
  const f = fixture(), reopen = f.write.reopenIssue; await f.command("/agent answer continue");
  f.write.reopenIssue = async () => { await reopen(); throw new Error("response lost"); };
  await f.pass(); await f.command("/agent stop", { when: "2026-11-12T12:03:00Z" });
  await f.pass();
  assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.deepEqual(f.writes, [["reopen"]]);
});

test("unknown issue reopening does not keep an obsolete Crew worker alive during stop", async () => {
  const f = fixture({ live: true }), reopen = f.write.reopenIssue; await f.command("/agent answer continue");
  f.write.reopenIssue = async () => { f.writes.push(["reopen-unknown"]); throw new Error("outcome unknown"); };
  await f.pass();
  await f.command("/agent stop", { when: "2026-11-12T12:03:00Z" });
  await f.pass();
  assert.deepEqual(f.writes, [["reopen-unknown"], ["cancel"]]);
  assert.equal(f.state.items["issue:7"].continuation.phase, "requested");
  await reopen(); await f.pass();
  assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.equal(f.writes.filter(([kind]) => kind === "cancel").length, 1);
});

test("a stop answer can correct a continue answer while its original request is still pending", async () => {
  const f = fixture(), reopen = f.write.reopenIssue; await f.command("/agent answer continue");
  f.write.reopenIssue = async () => { f.writes.push(["reopen-unknown"]); throw new Error("outcome unknown"); };
  await f.pass();
  await f.command("/agent answer stop", { when: "2026-11-12T12:03:00Z" });
  await f.pass();
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.equal(f.state.items["issue:7"].continuation.phase, "requested");
  await reopen(); await f.pass();
  assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  assert.equal(f.state.items["issue:7"].paused, true);
  assert.deepEqual(f.writes, [["reopen-unknown"], ["reopen"]]);
});

test("an unclear or stale numbered answer asks once and cannot reopen changed issue requirements", async () => {
  for (const text of ["maybe", "1"]) {
    const f = fixture(); await f.command(`/agent answer ${text}`);
    if (text === "1") {
      const original = f.api.issue;
      f.api.issue = async () => ({ ...await original(), body: "Changed requirements" });
    }
    await f.pass();
    const question = f.state.items["issue:7"].question;
    assert.equal(question.kind, "issue-closure");
    assert.equal(Object.values(f.state.items["issue:7"].commands)[0].status, "applied");
    await f.pass(); assert.equal(f.state.items["issue:7"].question.id, question.id);
    assert.deepEqual(f.writes, []);
  }
});

test("a human reclosure after an unrecorded App reopen needs a fresh decision instead of another write", async () => {
  const f = fixture(), reopen = f.write.reopenIssue; await f.command("/agent answer continue");
  f.write.reopenIssue = async () => { await reopen(); f.issueState = "closed"; throw new Error("response lost"); };
  await f.pass(); await f.pass();
  const item = f.state.items["issue:7"];
  assert.equal(item.continuation.phase, "superseded"); assert.equal(item.question.kind, "issue-closure");
  assert.match(item.question.reason, /closed again/); assert.deepEqual(f.writes, [["reopen"]]);
});

test("a changed authorizing answer fences further writes while retaining recovery of its sent request", async () => {
  const f = fixture(), row = await f.command("/agent answer continue"), reopen = f.write.reopenIssue;
  f.write.reopenIssue = async () => { f.writes.push(["reopen-unknown"]); throw new Error("outcome unknown"); };
  await f.pass(); row.body = "/agent answer something else"; row.updated_at = "2026-11-12T12:03:00Z";
  await f.pass();
  assert.equal(f.state.items["issue:7"].generation, 1);
  assert.equal(f.state.items["issue:7"].continuation.phase, "requested");
  await reopen(); await f.pass();
  assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  assert.match(f.state.items["issue:7"].question.reason, /changed or disappeared/);
  assert.deepEqual(f.writes, [["reopen-unknown"], ["reopen"]]);
});

test("known reopen rejections exhaust their budget and ask once before another explicit attempt", async () => {
  const f = fixture(), reopen = f.write.reopenIssue; await f.command("/agent answer continue");
  f.write.reopenIssue = async () => { f.writes.push(["rejected"]); throw Object.assign(new Error("forbidden"), { status: 403 }); };
  for (const time of ["2026-11-12T12:02:00Z", "2026-11-12T12:04:00Z", "2026-11-12T12:06:00Z", "2026-11-12T12:07:00Z"]) {
    f.tick(time); await f.pass();
  }
  const question = f.state.items["issue:7"].question;
  assert.equal(question.kind, "issue-closure"); assert.equal(f.state.items["issue:7"].continuation.phase, "superseded");
  await f.pass(); assert.equal(f.state.items["issue:7"].question.id, question.id);
  assert.equal(f.writes.length, 3);
  f.write.reopenIssue = reopen;
  await f.command("/agent answer continue", { when: "2026-11-12T12:08:00Z" });
  f.tick("2026-11-12T12:09:00Z"); await f.pass();
  assert.equal(f.state.items["issue:7"].continuation.phase, "done");
  assert.equal(f.state.items["issue:7"].attempts.length, 0);
});

test("a numbered stop answer cancels the live generation and keeps the issue closed", async () => {
  const f = fixture({ live: true }); await f.command("/agent answer 2");
  await f.pass();
  assert.equal(f.state.items["issue:7"].paused, true); assert.equal(f.state.items["issue:7"].generation, 1);
  assert.equal(f.issueState, "closed"); assert.deepEqual(f.writes, [["cancel"]]);
});

test("finishing every PR while the closure question is waiting consumes the answer without reopening", async () => {
  const f = fixture(); await f.command("/agent answer continue");
  f.pr.state = "closed"; f.pr.merged_at = at; f.pr.merge_commit_sha = C;
  await f.pass();
  assert.equal(f.state.items["issue:7"].complete, true);
  assert.equal(Object.values(f.state.items["issue:7"].commands)[0].status, "applied");
  assert.equal(f.state.items["issue:7"].continuation, undefined); assert.deepEqual(f.writes, []);
});

test("seeded continuation interleavings keep one unknown request through duplicates, stop and human changes", async () => {
  const seed = 20261112; let random = seed >>> 0;
  const draw = (limit) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % limit; };
  const witnesses = { lateAfterStop: 0, humanReclosure: 0, sourceChange: 0 };
  for (let trial = 0; trial < 30; trial++) {
    const f = fixture(), row = await f.command("/agent answer continue");
    let requests = 0, applied = false, stopped = false, eventId = 10000;
    f.write.reopenIssue = async () => { requests++; throw new Error("request outcome unknown"); };
    await f.pass();
    for (let step = 0; step < 25; step++) {
      const time = new Date(Date.parse("2026-11-12T12:03:00Z") + step * 60_000).toISOString(); f.tick(time);
      switch (draw(6)) {
        case 0:
          await f.command("/agent stop", { when: time }); stopped = true;
          break;
        case 1:
          if (!applied) {
            applied = true; f.issueState = "open";
            f.events.push({ id: eventId++, event: "reopened", created_at: time, actor: { login: "ntodd-agent[bot]" } });
            if (stopped) witnesses.lateAfterStop++;
          }
          break;
        case 2:
          f.issueState = f.issueState === "open" ? "closed" : "open";
          f.events.push({ id: eventId++, event: f.issueState === "open" ? "reopened" : "closed", created_at: time, actor: { login: "ntodd" } });
          if (applied && f.issueState === "closed") witnesses.humanReclosure++;
          break;
        case 3:
          if (row.updated_at === row.created_at) { row.updated_at = time; row.body = "Edited after the request"; witnesses.sourceChange++; }
          break;
      }
      await f.pass();
      const context = `seed=${seed} trial=${trial} step=${step}`;
      assert.equal(requests, 1, context);
      assert.equal(f.state.items["issue:7"].attempts.length, 0, context);
      if (stopped) assert.equal(f.state.items["issue:7"].paused, true, context);
      if (!applied) assert.equal(f.state.items["issue:7"].continuation.phase, "requested", context);
    }
  }
  assert.ok(Object.values(witnesses).every((count) => count > 0), JSON.stringify({ seed, witnesses }));
});
