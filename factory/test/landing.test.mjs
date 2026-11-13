import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { evolve, validateLedger } from "../lib/protocol.mjs";
import { observeItem } from "../lib/observe.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { parseConfig } from "../lib/config.mjs";
import { ingestCommands } from "../lib/commands.mjs";
import { classifyText } from "../lib/admission.mjs";
import { publicationGaps } from "../lib/effects.mjs";
import { projectItem, surfaceService } from "../lib/surfaces.mjs";
import { defaultLanding, initial, reserve, observation, artifact, A, B, C, D, at } from "./fixtures.mjs";
const E = "e".repeat(40), tree = (sha) => createHash("sha1").update(`tree:${sha}`).digest("hex");

function publish(state, commit, { id = `op-${state.items["issue:7"].attempts.length + 1}`, number = 9, head = B, inputs = [] } = {}) {
  const run = { id: String(100 + state.items["issue:7"].attempts.length), attempt: 1 }, branch = number ? "factory/issue-7" : `factory/issue-7-${id}`;
  const event = (type, extra) => { state = evolve(state, "issue:7", { type, operationId: id, at, publisher: { id: "900", attempt: 1 }, ...extra }); };
  event("reserve", { ...reserve(id), operationId: id, id, mode: number ? "respond" : "build", limit: 100,
    target: { number, branch, head }, commandIds: inputs, automatic: !inputs.length });
  const fresh = { ...observation, head };
  event("claim", { run, provenance: { repositoryId: "42", workflowPath: ".github/workflows/factory.yml", headSha: A }, observation: fresh });
  event("owner-observed", { run, status: "completed", conclusion: "success" });
  event("collect-result", { artifact: { ...artifact, run }, proposal: { schemaVersion: 1, operationId: id, run, outcome: "ready",
    pullRequest: { title: "Fix it", body: "Issue: #7" }, effects: [{ id: "push", type: "push", branch, expectedHead: head, commit, baseSha: A }] } });
  event("authorize-publish", { observation: fresh });
  event("request-effect", { effectId: "push", observation: fresh });
  event("effect-observed", { effectId: "push", requestId: `${id}/push/1`, outcome: "applied", evidence: { kind: "branch-head", commit } });
  if (!number) {
    event("request-effect", { effectId: "pull-request", observation: { ...fresh, head: commit } });
    event("effect-observed", { effectId: "pull-request", requestId: `${id}/pull-request/1`, outcome: "applied",
      evidence: { kind: "pull-request", number: 11, state: "merged", mergedSha: E, commit, head: branch, base: "main" } });
  }
  event("finish-publish"); return state;
}

function fixture({ commits = [C], merged = B, main = D } = {}) {
  let state = initial(), clock = at, head = B, id = 1000;
  for (const commit of commits) { state = publish(state, commit, { head }); head = commit; }
  for (const [number, mergedSha] of [[9, merged], [10, main]]) state = evolve(state, "issue:7", { type: "pr-observed", number, state: "merged", mergedSha, baseRef: "main", defaultLanding: defaultLanding(mergedSha) });
  const config = parseConfig("trusted-users: [ntodd]\nmax-rounds: 20"), rows = [], compared = [], objects = [];
  let compare = async (base, destination) => ({ status: destination === B ? "behind" : "diverged", base_commit: { sha: base }, merge_base_commit: { sha: A } });
  let object = async (sha) => ({ sha, tree: { sha: tree(sha) } });
  const issue = { number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" } };
  const api = { repository: async () => ({ id: 42, default_branch: "main" }), issue: async () => issue, editors: async () => [],
    events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async (n) => n === 7 ? rows : [], reviews: async () => [], threads: async () => [], branchSha: async () => main,
    pull: async (number) => ({ number, state: "closed", merged_at: at, merge_commit_sha: state.items["issue:7"].prs.find((p) => p.number === number).mergedSha,
      head: { sha: head }, base: { ref: "main" } }), checks: async (sha) => ({ sha, statuses: [], checkRuns: [] }),
    compare: async (base, destination) => { compared.push([base, destination]); return compare(base, destination); },
    commit: async (sha) => { objects.push(sha); return object(sha); } };
  return { api, compared, objects, issue, get state() { return state; }, set state(value) { state = validateLedger(value); },
    set compare(fn) { compare = fn; }, set object(fn) { object = fn; }, tick(value) { clock = value; },
    observe: () => observeItem({ api, actions: {}, ledger: state, key: "issue:7", context: { config, repo: "ntodd/project", defaultBranch: "main", sha: main, repositoryId: "42" },
      rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }], now: () => clock }),
    reconcile(facts) { const plan = decideItem(state, "issue:7", facts, config, { now: clock }); for (const event of plan.events) state = evolve(state, "issue:7", event); return plan; },
    command(text) { const row = { id: id++, body: `/agent answer ${text}`, user: { login: "ntodd" }, created_at: clock, updated_at: clock }; rows.push(row);
      state = ingestCommands(state, "issue:7", [classifyText(row, "issue-comment", config, { target: 7 })]); return Object.values(state.items["issue:7"].commands).at(-1); } };
}

test("unlanded branch code blocks completion without an issue edit and is reported separately from its merged commit", async () => {
  const f = fixture(), plan = f.reconcile(await f.observe());
  assert.equal(plan.action.type, "ask"); assert.equal(f.state.items["issue:7"].complete, false);
  assert.equal(f.state.items["issue:7"].question.kind, "completion-revision");
  assert.match(plan.action.reason, new RegExp(C)); assert.match(plan.action.reason, new RegExp(B));
  assert.equal(f.state.operations["op-1"].effects[0].landing.reason, "unverified");
  const pr = projectItem(f.state, "issue:7").find((p) => p.target === 9);
  assert.equal(pr.status.state, "agent-needs-you"); assert.match(pr.body, /Landing is not verified/);
  assert.equal(pr.status.next, "answer");
  assert.throws(() => evolve(f.state, "issue:7", { type: "close-out" }), (e) => e.code === "incomplete");
});

test("verified ancestry and exact tree equivalence both account for rewritten merge results", async () => {
  for (const method of ["ancestor", "tree"]) {
    const f = fixture({ merged: E });
    if (method === "ancestor") f.compare = async (base) => ({ status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base } });
    else f.object = async (sha) => ({ sha, tree: { sha: [C, E].includes(sha) ? "1".repeat(40) : tree(sha) } });
    const plan = f.reconcile(await f.observe());
    assert.equal(plan.action.type, "close-out"); assert.equal(f.state.items["issue:7"].complete, true);
    const proof = f.state.operations["op-1"].effects[0].landing;
    assert.equal(proof.status, "landed"); assert.equal(proof.method, method); assert.equal(proof.destination, E);
    assert.equal(f.state.items["issue:7"].prs[0].mergedSha, E);
  }
});

test("missing landing evidence backs off without hiding merged PR facts and can recover through the default branch", async () => {
  const f = fixture();
  f.compare = async () => { throw new Error("private service detail"); }; f.object = async () => { throw new Error("unavailable"); };
  assert.equal(f.reconcile(await f.observe()).status.next, "landing");
  const count = f.compared.length; f.reconcile(await f.observe()); assert.equal(f.compared.length, count);
  assert.equal(f.state.items["issue:7"].prs[0].mergedSha, B); assert.equal(f.state.items["issue:7"].question, null);
  assert.equal(JSON.stringify(f.state).includes("private service detail"), false);
  f.tick("2026-11-12T12:01:00Z");
  f.compare = async (base, destination) => ({ status: destination === D ? "ahead" : "behind", base_commit: { sha: base }, merge_base_commit: { sha: destination === D ? base : A } });
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  const proof = f.state.operations["op-1"].effects[0].landing;
  assert.equal(proof.source, "main"); assert.equal(proof.destination, D); assert.equal(proof.checks, 2);
});

test("a landed descendant accounts for earlier factory pushes without one API lookup per operation", async () => {
  const f = fixture({ commits: [C, D], merged: E, main: E });
  f.compare = async (base) => ({ status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base } });
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.deepEqual(f.compared, [[D, E]]); assert.equal(f.state.operations["op-1"].effects[0].landing, undefined);
  assert.deepEqual(publicationGaps(f.state, "issue:7"), []);
});

test("landing probes are bounded per pass and backoff does not starve older publications", async () => {
  const commits = Array.from({ length: 6 }, (_, n) => (1000 + n).toString(16).padStart(40, "0")), f = fixture({ commits, main: B });
  const first = await f.observe(); assert.equal(first.landings.length, 4); f.reconcile(first);
  const second = await f.observe(); assert.equal(second.landings.length, 2); f.reconcile(second);
  assert.equal(Object.values(f.state.operations).filter((op) => op.effects[0].landing?.status === "unknown").length, 6);
});

test("fresh completion acceptance is scoped to the question and cannot reuse an old answer after the issue changes", async () => {
  const f = fixture(); f.reconcile(await f.observe());
  f.tick("2026-11-12T12:01:00Z"); f.command("1"); f.issue.body = "Revised requirements";
  f.tick("2026-11-12T12:02:00Z"); assert.equal(f.reconcile(await f.observe()).action.type, "ask");
  assert.equal(f.state.items["issue:7"].complete, false);
  f.tick("2026-11-12T12:03:00Z"); f.command("accept-completion");
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.equal(f.state.items["issue:7"].completionAcceptance.generation, 0);
  const gaps = publicationGaps(f.state, "issue:7"); assert.equal(gaps[0].accepted, true);
  assert.match(projectItem(f.state, "issue:7").find((p) => p.target === 9).body, /explicitly accepted/);
  assert.equal(f.state.items["issue:7"].prs[0].mergedSha, B);
});

test("a completion decision cannot waive a later generation's publication after restart", async () => {
  const f = fixture(); f.reconcile(await f.observe()); f.tick("2026-11-12T12:01:00Z"); f.command("accept-completion"); f.reconcile(await f.observe());
  let state = ingestCommands(f.state, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:2001", revision: "e".repeat(64),
    author: "ntodd", createdAt: "2026-11-12T12:02:00Z", target: 7, command: { action: "restart", text: "" } }]);
  const commandId = Object.values(state.items["issue:7"].commands).find((c) => c.sourceId === "issue-comment:2001").id;
  for (const event of [{ type: "begin-restart" }, { type: "plan-restart", targets: [], retire: [9, 10] }, { type: "finish-restart" }]) {
    state = evolve(state, "issue:7", { ...event, commandId, at });
  }
  state = publish(state, "f".repeat(40), { number: null, head: null, inputs: [commandId] });
  const gaps = publicationGaps(state, "issue:7");
  assert.equal(gaps.length, 1); assert.equal(gaps[0].number, 11); assert.equal(gaps[0].accepted, false);
  assert.throws(() => evolve(state, "issue:7", { type: "close-out" }), (e) => e.code === "incomplete");
});

test("corrupt landing proofs and stale acceptance cannot turn unmerged code into completed work", async () => {
  const f = fixture(), facts = await f.observe(); f.reconcile(facts);
  for (const patch of [{ commit: D }, { status: "landed", source: "pr", number: 10, destination: B, method: "ancestor" }, { nextAt: "2026-11-13T12:00:00Z" }]) {
    const state = structuredClone(f.state); Object.assign(state.operations["op-1"].effects[0].landing, patch);
    assert.throws(() => validateLedger(state), (e) => e.code === "corrupt");
  }
  const state = structuredClone(f.state); state.items["issue:7"].completionAcceptance = { sourceId: "missing", revision: state.items["issue:7"].revision, generation: 0, at };
  assert.throws(() => validateLedger(state), (e) => e.code === "corrupt");
});

test("unavailable landing evidence reaches a bounded human decision without treating a receipt as completion", async () => {
  const f = fixture();
  f.compare = async () => { throw new Error("unavailable"); }; f.object = async () => { throw new Error("unavailable"); };
  assert.equal(f.reconcile(await f.observe()).status.next, "landing");
  const deadline = f.state.items["issue:7"].status.wait.deadline;
  assert.equal(deadline, "2026-11-12T12:15:00.000Z");
  f.tick("2026-11-12T12:14:00Z"); assert.equal(f.reconcile(await f.observe()).status.wait.deadline, deadline);
  f.tick(deadline); assert.equal(f.reconcile(await f.observe()).action.type, "ask");
  assert.equal(f.state.items["issue:7"].question.kind, "completion-revision");
  assert.equal(f.state.items["issue:7"].complete, false);
});

test("comparison and tree responses must identify the exact published and destination commits", async () => {
  const f = fixture({ merged: E });
  f.compare = async () => ({ status: "ahead", base_commit: { sha: B }, merge_base_commit: { sha: C } });
  f.object = async () => ({ sha: B, tree: { sha: "1".repeat(40) } });
  f.reconcile(await f.observe());
  assert.equal(f.state.operations["op-1"].effects[0].landing.status, "unknown");
  assert.equal(f.state.operations["op-1"].effects[0].landing.reason, "unavailable");
  assert.equal(f.state.items["issue:7"].complete, false);
});

test("an exact default-branch commit bypasses read backoff and durable positive evidence cannot be downgraded", async () => {
  const f = fixture(); f.reconcile(await f.observe());
  f.api.branchSha = async () => C;
  const count = f.compared.length;
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.equal(f.compared.length, count);
  const proof = f.state.operations["op-1"].effects[0].landing;
  assert.equal(proof.source, "main"); assert.equal(proof.method, "commit"); assert.equal(proof.destination, C);
  const next = evolve(f.state, "issue:7", { type: "record-landing", operationId: "op-1", effectId: "push", landing: {
    status: "unknown", reason: "unavailable", commit: C, at: "2026-11-12T12:02:00Z", firstAt: at, nextAt: "2026-11-12T12:03:00Z", checks: 3,
  } });
  assert.deepEqual(next.operations["op-1"].effects[0].landing, proof);
});

test("maintenance of a human PR needs the same explicit disposition for a post-merge publication", async () => {
  const f = fixture(), facts = await f.observe(), state = structuredClone(f.state);
  const item = state.items["issue:7"]; delete state.items["issue:7"]; state.items["pr:9"] = item;
  item.key = "pr:9"; item.evidence.own = true;
  for (const op of Object.values(state.operations)) op.item = "pr:9";
  let current = validateLedger(state);
  const reconcile = (facts, now) => {
    const plan = decideItem(current, "pr:9", facts, parseConfig("trusted-users: [ntodd]"), { now });
    for (const event of plan.events) current = evolve(current, "pr:9", event);
    return plan;
  };
  assert.equal(reconcile(facts, at).action.type, "ask");
  assert.match(current.items["pr:9"].question.reason, /Bring any missing work to the default branch in a follow-up PR/);
  current = ingestCommands(current, "pr:9", [{ authority: "instruction", sourceId: "issue-comment:2002", revision: "e".repeat(64),
    author: "ntodd", createdAt: "2026-11-12T12:01:00Z", target: 9, command: { action: "answer", text: "accept-completion" } }]);
  assert.equal(reconcile({ ...facts, landings: [] }, "2026-11-12T12:01:00Z").action.type, "close-out");
  assert.equal(current.items["pr:9"].complete, true);
  assert.equal(current.items["pr:9"].prs[0].mergedSha, B);
});

test("issue closure refuses an old complete flag when a branch publication has no landing evidence", async () => {
  const f = fixture(), state = structuredClone(f.state); state.items["issue:7"].complete = true;
  const writes = [];
  const service = surfaceService({ api: f.api, write: { closeIssue: async () => writes.push("close") },
    store: { load: async () => ({ state: validateLedger(state) }), transact: async () => { throw new Error("Must reject before preparing a close request"); } },
    repo: "ntodd/project", appLogin: "ntodd-agent[bot]", run: { id: "900", attempt: 1 } });
  assert.equal((await service.closeOut({ key: "issue:7" })).status, "superseded");
  assert.deepEqual(writes, []);
});
