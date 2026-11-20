import { test } from "node:test";
import assert from "node:assert/strict";
import { runController } from "../lib/controller.mjs";
import { admit, revisionOf, validateLedger } from "../lib/protocol.mjs";
import { repairSpec } from "../lib/main-repair.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, A, B, C, D, at } from "./fixtures.mjs";

const report = (value = 2) => `  1) test a value (ValueTest)\n     test/value_test.exs:3\n     Assertion with == failed\n     code: assert value == ${value}\n     left: 1\n     right: ${value}\n     stacktrace:\n       test/value_test.exs:4: (test)\n\n1 test, 1 failure\n`;
function fixture() {
  let state = initial(), main = A, includeRepair = false, mainGreen = false, id = 0;
  state.items["issue:7"].prs.pop();
  const issues = new Map([[7, { number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" }, labels: [] }],
    [8, { number: 8, title: "Repair main", body: `Repair the failure\n<!-- agent-ready:source=main-red key=${A} -->`, state: "open",
      user: { login: "github-actions[bot]" }, labels: [{ name: "agent-ready" }] }]]);
  const outputs = new Map([[A, report()], [B, report()], [D, report()]]), dispatches = [];
  const configText = "trusted-users: [ntodd]\nproducers: [main-red]";
  const pr = { number: 9, state: "open", user: { login: "ntodd-agent[bot]" }, mergeable: true,
    head: { sha: B, ref: "factory/issue-7", repo: { full_name: "ntodd/project" } }, base: { ref: "main", sha: A } };
  const api = {
    repository: async () => ({ id: 42, default_branch: "main" }), fileAt: async () => ({ content: configText }),
    branchSha: async (ref) => { if (ref === "main") return main; if (ref === pr.head.ref) return pr.head.sha;
      throw Object.assign(new Error("No branch"), { status: 404 }); },
    openIssues: async () => [issues.get(7), ...(includeRepair ? [issues.get(8)] : [])], openPulls: async () => [],
    issue: async (number) => issues.get(number), pull: async () => pr, editors: async () => [], comments: async () => [], reviews: async () => [], threads: async () => [],
    events: async (number) => [{ id: number === 7 ? 123 : 124, event: "labeled", created_at: at, label: { name: "agent-ready" },
      actor: { login: number === 7 ? "ntodd" : "github-actions[bot]" } }],
    branchRules: async () => [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test", integration_id: 1 }] } }],
    pullStatus: async () => ({ headRefOid: B, baseRefOid: main, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" }),
    compare: async (base, head) => ({ status: "ahead", behind_by: head === B && base !== A ? 1 : 0 }),
    checks: async (sha) => ({ sha, statuses: [], checkRuns: [{ id: sha === A ? 201 : sha === B ? 202 : 203, head_sha: sha,
      name: "test", app: { id: 1 }, status: "completed", conclusion: mainGreen && sha === main ? "success" : "failure",
      started_at: at, output: { summary: outputs.get(sha) ?? "" } }] }),
  };
  const store = { load: async () => ({ state: structuredClone(state) }), transact: async (fn) => {
    state = validateLedger(await fn(structuredClone(state))); return { state: structuredClone(state) };
  } };
  const pass = (extra = {}) => runController({ api, store, write: { dispatch: async (_workflow, _branch, request) => dispatches.push(request) }, actions: {},
    repo: "ntodd/project", toolingSha: C, run: { id: "900", attempt: 1 }, now: () => at, operationId: () => `op-${++id}`, maxPasses: 1, ...extra });
  return { api, store, issues, outputs, dispatches, pr, pass, get state() { return state; },
    repair() { includeRepair = true; }, move(sha) { main = sha; }, green() { mainGreen = true; } };
}

test("a shared main failure asks for admitted repair work instead of starting another PR fix", async () => {
  const f = fixture(); await f.pass();
  const item = f.state.items["issue:7"];
  assert.equal(item.question.kind, "main-failure");
  assert.equal(item.question.dependency.baseSha, A);
  assert.match(item.question.reason, /no admitted repair issue/);
  assert.deepEqual(f.dispatches, []);
});

test("admitting the matching repair settles the dependency question and dispatches only its build", async () => {
  const f = fixture(); await f.pass(); f.repair(); await f.pass();
  assert.equal(f.state.items["issue:7"].question, null);
  assert.equal(f.state.items["issue:7"].status.wait.kind, "main-green");
  assert.match(f.state.items["issue:7"].status.reason, /#8/);
  assert.equal(f.state.items["issue:8"].mainRepair.baseSha, A);
  assert.equal(f.state.items["issue:8"].mainRepair.keys.length, 1);
  assert.deepEqual(f.dispatches.map((d) => d.item), ["issue:8"]);
  const op = f.state.operations[f.state.items["issue:8"].activeOperation];
  assert.equal(op.failureContext.repairBase, A); assert.equal(op.failureContext.main.state, "failure");
  assert.equal(f.state.items["issue:7"].attempts.length, 0);
});

test("repair relevance survives a new main commit only for the same recorded diagnostic", async () => {
  const f = fixture(); f.repair(); await f.pass(); f.move(D); await f.pass();
  assert.equal(f.state.items["issue:7"].status.wait.kind, "main-green");
  assert.match(f.state.items["issue:7"].status.reason, /#8/);
  f.outputs.set(D, report(500));
  await f.store.transact((s) => admit(s, { key: "issue:10", revision: revisionOf({ title: "Ordinary", body: "Task" }), evidence: {
    kind: "label", sourceId: "label:130", actor: "ntodd", at }, prs: [] }));
  f.issues.set(10, { number: 10, title: "Ordinary", body: "Task", state: "open", user: { login: "ntodd" }, labels: [] });
  const original = f.api.events;
  f.api.events = async (number) => number === 10 ? [{ id: 130, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }] : original(number);
  await f.pass();
  assert.equal(f.state.items["issue:10"].question.kind, "main-failure");
  assert.equal(f.state.items["issue:10"].question.dependency.baseSha, D);
  assert.equal(f.dispatches.some((d) => d.item === "issue:10"), false);
});

test("mixed PR and main diagnostics authorize PR work with the shared failure marked as deferred data", async () => {
  const f = fixture(); f.outputs.set(B, report(500)); await f.pass();
  assert.deepEqual(f.dispatches.map((d) => d.item), ["issue:7"]);
  const op = f.state.operations[f.state.items["issue:7"].activeOperation];
  assert.equal(op.mode, "respond"); assert.equal(op.failureContext.pr.failures[0].attribution, "pr-specific");
  assert.equal(op.failureContext.main.state, "failure");
});

test("one check with a shared failure and an independent regression preserves both classifications for its worker", async () => {
  const f = fixture();
  f.outputs.set(B, report().split("\n1 test,")[0] + report(500).replace("1) test", "2) test").replace("1 test, 1 failure", "2 tests, 2 failures"));
  await f.pass();
  const op = f.state.operations[f.state.items["issue:7"].activeOperation];
  assert.equal(op.mode, "respond");
  assert.deepEqual(op.failureContext.pr.failures[0].diagnostics.map((d) => d.sharedMain), [true, false]);
  assert.equal(op.failureContext.main.failures[0].diagnostics.length, 1);
});

test("human repair declarations use the same admission and priority path", async () => {
  const f = fixture(); f.repair();
  f.issues.get(8).user.login = "ntodd"; f.issues.get(8).body = `Repair main\n<!-- factory:repair-base=${A} -->`;
  const events = f.api.events;
  f.api.events = async (number) => (await events(number)).map((e) => ({ ...e, actor: { login: "ntodd" } }));
  await f.pass();
  assert.deepEqual(f.dispatches.map((d) => d.item), ["issue:8"]);
  assert.equal(f.state.items["issue:8"].mainRepair.baseSha, A);
});

test("an overdue dependency stays a question until something changes, while paused repair state is visible", async () => {
  const f = fixture(); f.repair(); await f.pass();
  await f.pass({ now: () => "2026-11-12T13:01:00Z" });
  const question = f.state.items["issue:7"].question;
  assert.equal(question.kind, "main-failure"); assert.equal(question.dependency.repairIssue, 8);
  await f.pass({ now: () => "2026-11-12T13:02:00Z" });
  assert.equal(f.state.items["issue:7"].question.id, question.id);
  const paused = fixture(); paused.repair(); await paused.pass();
  await paused.store.transact((s) => { s.items["issue:8"].paused = true; s.items["issue:8"].generation++; return s; });
  await paused.pass();
  assert.match(paused.state.items["issue:7"].status.reason, /#8 \(paused\)/);
});

test("closing a repair issue cannot stand in for green current-main CI", async () => {
  const f = fixture(); f.repair(); await f.pass(); f.issues.get(8).state = "closed";
  await f.pass();
  assert.equal(f.state.items["issue:7"].question.kind, "main-failure");
  assert.match(f.state.items["issue:7"].question.reason, /no admitted repair issue/);
  assert.equal(f.state.items["issue:7"].attempts.length, 0);
});

test("a generic job failure on both commits asks for diagnostics without guessing that the names match", async () => {
  const f = fixture(); f.outputs.set(A, "Process completed with exit code 1."); f.outputs.set(B, "Process completed with exit code 1.");
  await f.pass();
  assert.equal(f.state.items["issue:7"].question.kind, "main-failure");
  assert.match(f.state.items["issue:7"].question.reason, /complete diagnostic evidence/);
  assert.deepEqual(f.dispatches, []);
});

test("current-head green main CI settles a dependency even while its repair issue is still open", async () => {
  const f = fixture(); await f.pass(); f.green(); await f.pass();
  assert.equal(f.state.items["issue:7"].question, null);
  assert.deepEqual(f.dispatches.map((d) => d.item), ["issue:7"]);
});

test("repair declarations come only from admitted trusted metadata, not log text or an opaque producer key", () => {
  const config = parseConfig("trusted-users: [ntodd]\nproducers: [main-red]");
  const human = { valid: true, revision: "e".repeat(64), evidence: { sourceId: "label:1" },
    issue: { user: { login: "ntodd" }, body: `Repair main\n<!-- factory:repair-base=${A} -->` } };
  assert.equal(repairSpec(human, config).baseSha, A);
  assert.equal(repairSpec({ ...human, issue: { ...human.issue, user: { login: "outsider" } } }, config), null);
  assert.equal(repairSpec({ ...human, producer: { source: "main-red", key: "compile" } }, config), null);
  assert.equal(repairSpec({ ...human, producer: { source: "flake-hunt", key: A } }, config), null);
  assert.equal(repairSpec({ ...human, valid: false }, config), null);
});
