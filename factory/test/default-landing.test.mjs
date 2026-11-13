import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { observeItem, publishObservation } from "../lib/observe.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { admit, emptyLedger, evolve, validateLedger } from "../lib/protocol.mjs";
import { parseConfig } from "../lib/config.mjs";
import { ingestCommands } from "../lib/commands.mjs";
import { classifyText, inspectOwnPr } from "../lib/admission.mjs";
import { completionGaps, landedCommits } from "../lib/effects.mjs";
import { projectItem, surfaceService } from "../lib/surfaces.mjs";
import { initial, pending, step, defaultLanding, A, B, C, D, at } from "./fixtures.mjs";

function fixture() {
  let state = initial(), clock = at, id = 1000;
  const comments = [];
  const config = parseConfig("trusted-users: [ntodd]"), compared = [], objects = [];
  const prs = new Map([9, 10].map((number) => [number, { number, state: "closed", merged_at: at, merge_commit_sha: number === 9 ? C : D,
    head: { sha: B }, base: { ref: number === 9 ? "feature" : "main" } }]));
  const api = { repository: async () => ({ id: 42, default_branch: "main" }), branchSha: async () => D,
    issue: async () => ({ number: 7, title: "Fix it", body: "Accepted task", state: "open", user: { login: "ntodd" } }),
    editors: async () => [], events: async () => [{ id: 123, event: "labeled", created_at: at, label: { name: "agent-ready" }, actor: { login: "ntodd" } }],
    comments: async (number) => number === 7 ? comments : [], reviews: async () => [], threads: async () => [], pull: async (number) => prs.get(number),
    checks: async (sha) => ({ sha, statuses: [], checkRuns: [] }),
    compare: async (base, head) => { compared.push([base, head]); return { status: "diverged", base_commit: { sha: base }, merge_base_commit: { sha: A } }; },
    commit: async (sha) => { objects.push(sha); return { sha, tree: { sha: createHash("sha1").update(sha).digest("hex") } }; } };
  const observe = () => observeItem({ api, actions: {}, ledger: state, key: "issue:7", context: { config, repo: "ntodd/project", repositoryId: "42", defaultBranch: "main", sha: D },
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }], now: () => clock });
  return { api, prs, compared, objects, observe, config, get state() { return state; }, set state(value) { state = validateLedger(value); }, tick(value) { clock = value; },
    command() { const row = { id: id++, body: "/agent answer accept-completion", user: { login: "ntodd" }, created_at: clock, updated_at: clock };
      comments.push(row); state = ingestCommands(state, "issue:7", [classifyText(row, "issue-comment", config, { target: 7 })]); },
    reconcile(facts) { const plan = decideItem(state, "issue:7", facts, config, { now: clock });
      for (const event of plan.events) state = evolve(state, "issue:7", event); return plan; } };
}

test("a merge into another branch cannot complete an issue without verified default-branch coverage", async () => {
  const f = fixture(), facts = await f.observe(), plan = f.reconcile(facts);
  assert.equal(facts.prs[0].baseRef, "feature");
  assert.equal(plan.action.type, "ask"); assert.match(plan.action.reason, /feature/);
  assert.equal(f.state.items["issue:7"].complete, false);
  assert.equal(f.state.items["issue:7"].prs[0].mergedSha, C);
  assert.throws(() => evolve(f.state, "issue:7", { type: "close-out" }), (e) => e.code === "incomplete");
});

test("ordinary default-branch merges complete without ancestry probes", async () => {
  const f = fixture(); f.prs.get(9).base.ref = "main";
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.equal(f.state.items["issue:7"].prs[0].defaultLanding.method, "base");
  assert.deepEqual(f.compared, []); assert.deepEqual(f.objects, []);
});

test("a human PR merged elsewhere also needs default coverage without any factory publications", async () => {
  const f = fixture(), facts = await f.observe(), state = structuredClone(f.state), item = state.items["issue:7"];
  delete state.items["issue:7"]; state.items["pr:9"] = item; item.key = "pr:9"; item.evidence.own = true;
  const plan = decideItem(validateLedger(state), "pr:9", facts, f.config, { now: at });
  assert.equal(plan.action.type, "ask"); assert.match(plan.action.reason, /feature/);
  const result = plan.events.reduce((s, e) => evolve(s, "pr:9", e), state);
  assert.match(plan.action.reason, /follow-up PR/); assert.equal(result.items["pr:9"].complete, false);
});

test("fresh authorization for a human PR merged elsewhere permits disposition while still fencing publication", async () => {
  const f = fixture(), pr = f.prs.get(9), context = { config: f.config, repo: "ntodd/project", repositoryId: "42", defaultBranch: "main", sha: D };
  const original = { id: 200, body: "/agent update", user: { login: "ntodd" }, created_at: at, updated_at: at };
  pr.state = "open"; pr.merged_at = null; pr.user = { login: "ntodd" }; pr.base.ref = "main";
  pr.head.ref = "human"; pr.head.repo = { full_name: context.repo };
  f.api.comments = async (number) => number === 9 ? [original] : [];
  f.api.events = async () => [];
  const authorization = await inspectOwnPr(f.api, 9, context, { commandId: "issue-comment:200" });
  assert.equal(authorization.valid, true);
  let state = admit(emptyLedger("42"), { key: "pr:9", revision: authorization.revision, evidence: authorization.evidence,
    prs: [{ number: 9, state: "open", required: true, mergedSha: null, acceptedClosure: false }] });
  pr.state = "closed"; pr.merged_at = at; pr.base.ref = "feature";
  const observe = (now) => observeItem({ api: f.api, actions: {}, ledger: state, key: "pr:9", context,
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }], now: () => now });
  const observed = await observe(at);
  assert.equal(observed.authorization.valid, true);
  state = ingestCommands(state, "pr:9", observed.feedback);
  const plan = decideItem(state, "pr:9", observed, f.config, { now: at });
  state = plan.events.reduce((s, e) => evolve(s, "pr:9", e), state);
  assert.equal(plan.action.type, "ask"); assert.equal(state.items["pr:9"].question.kind, "completion-revision");
  assert.equal(state.items["pr:9"].authorizationRevoked, undefined); assert.equal(state.items["pr:9"].complete, false);
  const answeredAt = "2026-11-12T12:01:00Z", answer = { ...original, id: 201, body: "/agent answer accept-completion", created_at: answeredAt, updated_at: answeredAt };
  f.api.comments = async (number) => number === 9 ? [original, answer] : [];
  const fresh = await observe(answeredAt);
  state = ingestCommands(state, "pr:9", fresh.feedback);
  const done = decideItem(state, "pr:9", fresh, f.config, { now: answeredAt });
  state = done.events.reduce((s, e) => evolve(s, "pr:9", e), state);
  assert.equal(done.action.type, "close-out", JSON.stringify({ action: done.action, commands: state.items["pr:9"].commands }));
  assert.equal(state.items["pr:9"].complete, true);
  assert.equal(state.items["pr:9"].prs[0].mergedSha, C);
  f.api.fileAt = async () => ({ content: "trusted-users: [ntodd]" });
  const guarded = await publishObservation(f.api, state.items["pr:9"], { target: { number: 9, branch: "human" }, base: { ref: "main" }, inputs: [] }, context.repo);
  assert.equal(guarded.open, false);
});

test("an off-default merge completes after verified ancestry or exact tree equivalence on the default branch", async () => {
  for (const method of ["commit", "ancestor", "tree"]) {
    const f = fixture();
    if (method === "commit") f.api.branchSha = async () => C;
    if (method === "ancestor") f.api.compare = async (base) => ({ status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base } });
    if (method === "tree") f.api.commit = async (sha) => ({ sha, tree: { sha: A } });
    assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
    const pr = f.state.items["issue:7"].prs[0];
    assert.equal(pr.defaultLanding.method, method); assert.equal(pr.defaultLanding.ref, "main");
    assert.equal(pr.mergeBase, "feature"); assert.equal(pr.mergedSha, C);
    assert.match(projectItem(f.state, "issue:7")[0].body, /into feature; default-branch landing is verified/);
  }
});

test("a stale repository default or identity cannot certify a newly observed merge", async () => {
  for (const repository of [{ id: 42, default_branch: "trunk" }, { id: 43, default_branch: "main" }]) {
    const f = fixture(); f.api.repository = async () => repository;
    const facts = await f.observe(), plan = f.reconcile(facts);
    assert.equal(plan.action, null); assert.equal(f.state.items["issue:7"].status.wait.kind, "landing");
    assert(facts.prs.every((p) => p.defaultLanding.reason === "unavailable"));
    assert.deepEqual(f.compared, []); assert.equal(f.state.items["issue:7"].complete, false);
  }
});

test("merge landing reads back off, escalate, and recover without changing the actual merged commit", async () => {
  const f = fixture(); let reads = 0;
  f.api.compare = async () => { reads++; throw new Error("unavailable"); };
  f.api.commit = async () => { throw new Error("unavailable"); };
  assert.equal(f.reconcile(await f.observe()).action, null);
  f.tick("2026-11-12T12:00:30Z"); assert.equal(f.reconcile(await f.observe()).action, null); assert.equal(reads, 1);
  f.tick("2026-11-12T12:16:00Z"); assert.equal(f.reconcile(await f.observe()).action.type, "ask");
  assert.equal(f.state.items["issue:7"].prs[0].mergedSha, C);
  f.api.branchSha = async () => C;
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.equal(f.state.items["issue:7"].prs[0].defaultLanding.method, "commit");
});

test("tree or compare responses identifying another commit cannot prove default-branch landing", async () => {
  const f = fixture();
  f.api.compare = async () => ({ status: "ahead", base_commit: { sha: A }, merge_base_commit: { sha: C } });
  f.api.commit = async () => ({ sha: A, tree: { sha: B } });
  assert.equal(f.reconcile(await f.observe()).action, null);
  assert.equal(f.state.items["issue:7"].prs[0].defaultLanding.reason, "unavailable");
  assert.equal(f.state.items["issue:7"].complete, false);
});

test("an explicit completion alternative binds the merged PR snapshot and rejects an answer to an older base", async () => {
  const f = fixture(); f.reconcile(await f.observe());
  f.tick("2026-11-12T12:02:00Z"); f.command(); f.prs.get(9).base.ref = "other";
  assert.equal(f.reconcile(await f.observe()).action.type, "ask");
  assert.equal(f.state.items["issue:7"].complete, false);
  f.tick("2026-11-12T12:03:00Z"); f.command();
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.deepEqual(f.state.items["issue:7"].completionAcceptance.prs, [{ number: 9, mergedSha: C }, { number: 10, mergedSha: D }]);
  assert.equal(f.state.items["issue:7"].prs[0].mergedSha, C);
  const old = structuredClone(f.state); delete old.items["issue:7"].completionAcceptance.prs;
  assert.throws(() => evolve(validateLedger(old), "issue:7", { type: "close-out" }), (e) => e.code === "incomplete");
});

test("a recorded default landing is historical evidence even after the repository default or base name changes", async () => {
  const f = fixture(); f.prs.get(9).base.ref = "main"; f.reconcile(await f.observe());
  const proof = f.state.items["issue:7"].prs[0].defaultLanding;
  f.prs.get(9).base.ref = "renamed"; f.api.repository = async () => ({ id: 42, default_branch: "trunk" });
  assert.equal(f.reconcile(await f.observe()).action.type, "close-out");
  assert.deepEqual(f.state.items["issue:7"].prs[0].defaultLanding, proof);
});

test("legacy merged membership and a PR receipt cannot seed default-branch coverage", () => {
  let s = step(pending(), { type: "effect-observed", effectId: "push", requestId: "op-1/push/1", outcome: "applied", evidence: { kind: "branch-head", commit: C } });
  s = step(s, { type: "finish-publish" });
  s = step(s, { type: "pr-observed", number: 9, state: "merged", mergedSha: C, baseRef: "feature" });
  s = step(s, { type: "pr-observed", number: 10, state: "merged", mergedSha: D, baseRef: "main", defaultLanding: defaultLanding(D) });
  s = step(s, { type: "record-landing", effectId: "push", landing: { status: "landed", commit: C, at, checks: 1, source: "pr", number: 9, destination: C, method: "commit" } });
  assert(!landedCommits(s, "issue:7").has(C)); assert.equal(completionGaps(s, "issue:7").length, 2);
  assert.throws(() => step(s, { type: "close-out" }), (e) => e.code === "incomplete");
  s = step(s, { type: "pr-observed", number: 9, state: "merged", mergedSha: C, baseRef: "feature",
    defaultLanding: { ...defaultLanding(C), method: "ancestor", destination: D } });
  assert(landedCommits(s, "issue:7").has(C)); assert.equal(step(s, { type: "close-out" }).items["issue:7"].complete, true);
});

test("merge certificates reject malformed identity and base evidence at transition and ledger load", () => {
  for (const proof of [{ ...defaultLanding(C), commit: D }, { ...defaultLanding(C), baseRef: "feature" }, { ...defaultLanding(C), method: "tree", tree: "invalid" }]) {
    assert.throws(() => step(initial(), { type: "pr-observed", number: 9, state: "merged", mergedSha: C, baseRef: "main", defaultLanding: proof }), (e) => e.code === "invalid");
    const s = initial(); Object.assign(s.items["issue:7"].prs[0], { state: "merged", mergedSha: C, defaultLanding: proof });
    assert.throws(() => validateLedger(s), (e) => e.code === "corrupt");
  }
});

test("old complete flags cannot close an issue while a required merge lacks default coverage", async () => {
  const f = fixture(); f.reconcile(await f.observe());
  const state = structuredClone(f.state); state.items["issue:7"].complete = true;
  let writes = 0;
  const service = surfaceService({ store: { load: async () => ({ state }) }, api: { request: async () => { writes++; } }, appLogin: "factory[bot]" });
  assert.equal((await service.closeOut({ key: "issue:7" })).status, "superseded"); assert.equal(writes, 0);
  assert.match(projectItem(state, "issue:7")[0].body, /into feature; default-branch landing is unverified/);
});

test("off-default merge probes share a bounded budget and backoff leaves room for older merges", async () => {
  const f = fixture(), state = structuredClone(f.state);
  for (let number = 20; number < 25; number++) {
    state.items["issue:7"].prs.push({ number, required: true, state: "open", mergedSha: null, acceptedClosure: false });
    f.prs.set(number, { ...f.prs.get(9), number, merge_commit_sha: number.toString(16).padStart(40, "0") });
  }
  f.state = state;
  const first = await f.observe(); f.reconcile(first);
  assert.equal(f.compared.length, 4); assert.equal(first.prs.filter((p) => p.defaultLanding?.status === "unknown").length, 4);
  const second = await f.observe(); f.reconcile(second);
  assert.equal(f.compared.length, 6); assert.equal(second.prs.filter((p) => p.defaultLanding?.status === "unknown").length, 6);
});
