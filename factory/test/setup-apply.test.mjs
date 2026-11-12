import { test } from "node:test";
import assert from "node:assert/strict";
import { setupPlan } from "../lib/setup.mjs";
import { applySetupPlan } from "../lib/setup-apply.mjs";
import { emptyLedger, validateLedger, recordFactoryApp } from "../lib/protocol.mjs";
import { bootstrapPlan, applyBootstrap } from "../lib/bootstrap.mjs";
import { A, B, C, D } from "./fixtures.mjs";

function fixture({ active = false } = {}) {
  const repository = { id: 42, full_name: "ntodd/project", default_branch: "main", permissions: { admin: true }, allow_auto_merge: false };
  const app = { id: 123, slug: "factory-app", permissions: { contents: "write", issues: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read" } };
  const plan = setupPlan({ repository, app, configText: "trusted-users: [ntodd]", checks: [{ context: "test", integration_id: 15368 }], ciWorkflows: ["CI"], dryRun: !active });
  const rows = new Map(), calls = [], rules = [], labels = [], pulls = [], refs = new Map([["main", A]]), secretNames = new Set(["AGENT_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  let state = emptyLedger("42"), variable = null, nextId = 10;
  const journal = { get: (slot) => structuredClone(rows.get(slot) ?? null), save: (slot, value) => rows.set(slot, structuredClone(value)) };
  const absent = () => { throw Object.assign(new Error("Not found"), { status: 404 }); };
  const api = {
    repository: async () => structuredClone(repository), rulesets: async () => structuredClone(rules), labels: async () => structuredClone(labels),
    createRuleset: async (value) => { calls.push(["rule-create", value.name]); const r = { ...structuredClone(value), id: nextId++ }; rules.push(r); return r; },
    updateRuleset: async (id, value) => { calls.push(["rule-update", id]); const r = { ...structuredClone(value), id }; rules.splice(rules.findIndex((x) => x.id === id), 1, r); return r; },
    createLabel: async (label) => { calls.push(["label", label.name]); labels.push(structuredClone(label)); },
    updateLabel: async (name, label) => { calls.push(["label", name]); labels.splice(labels.findIndex((l) => l.name === name), 1, structuredClone(label)); },
    variable: async () => variable ?? absent(), createVariable: async (v) => { calls.push(["variable"]); variable = structuredClone(v); },
    updateVariable: async (_name, v) => { calls.push(["variable"]); variable = structuredClone(v); },
    secretNames: async () => [...secretNames], setSecret: async (name) => { calls.push(["secret", name]); secretNames.add(name); },
    settings: async (value) => { calls.push(["settings"]); Object.assign(repository, value); },
    branchSha: async (branch) => refs.get(branch) ?? absent(),
    commit: async (id) => ({ sha: id, tree: { sha: id === A ? B : D }, parents: id === A ? [] : [{ sha: A }] }),
    fileAt: async () => absent(), createTree: async () => { calls.push(["tree"]); return { sha: D }; },
    createCommit: async () => { calls.push(["commit"]); return { sha: C, tree: { sha: D }, parents: [{ sha: A }] }; },
    createBranch: async (branch, sha) => { calls.push(["branch"]); refs.set(branch, sha); return { object: { sha } }; },
    pullsFor: async () => structuredClone(pulls), createPull: async (data) => {
      calls.push(["pr"]); const p = { number: 19, html_url: "https://github.com/ntodd/project/pull/19", state: "open", body: data.body,
        head: { ref: data.head, sha: C }, base: { ref: data.base } }; pulls.push(p); return p;
    },
    workflows: async () => [], liveWorkflowRuns: async () => [], openPulls: async () => [],
    branchRules: async () => rules.filter((r) => r.name.startsWith("factory-state-")).flatMap((r) => r.rules.map((rule) => ({ ...rule, ruleset_id: r.id }))),
  };
  const store = { load: async () => ({ state: structuredClone(state) }), initialize: async () => { calls.push(["state-read"]); return { state }; },
    transact: async (fn) => {
      const next = validateLedger(await fn(structuredClone(state)));
      if (JSON.stringify(state) !== JSON.stringify(next)) calls.push(["state-write"]);
      state = next; return { state: structuredClone(state) };
    } };
  const apply = (extra = {}) => applySetupPlan({ plan, api, store, journal, ...extra });
  return { plan, api, store, journal, rows, calls, rules, labels, pulls, refs, repository, secretNames, apply, set state(value) { state = value; } };
}

test("setup verifies protections and opens one two-file PR; repeating it sends no duplicate mutations", async () => {
  const f = fixture();
  const first = await f.apply();
  assert.equal(first.status, "pending-merge"); assert.equal(first.pr, 19); assert.equal(first.protectionsVerified, true);
  assert.equal(f.rules.length, 4); assert.equal(f.labels.length, 14); assert.equal(f.repository.allow_auto_merge, true);
  assert.deepEqual((await f.store.load()).state.factoryApp, { id: "123", login: "factory-app[bot]" });
  const mutations = () => f.calls.filter(([kind]) => kind !== "state-read");
  const before = mutations().length;
  await f.apply();
  assert.equal(mutations().length, before);
  assert.equal(f.calls.filter(([kind]) => kind === "pr").length, 1);
});

test("bootstrap publishes only a pinned read-only caller/config, recovers a lost PR response and leaves App identity unverified", async () => {
  const f = fixture();
  f.api.variable = async () => ({ name: "AGENT_APP_ID", value: "123" });
  const plan = bootstrapPlan({ repository: f.repository, configText: "trusted-users: [ntodd]", baseSha: A, appIdCandidate: "123", ciWorkflows: ["CI"], ref: B });
  const apply = (extra = {}) => applyBootstrap({ plan, api: f.api, journal: f.journal, ...extra });
  const preview = await apply({ preview: true });
  assert.equal(preview.plan.mode, "bootstrap-read-only"); assert.deepEqual(f.calls, []); assert.equal(f.rows.size, 0);
  const create = f.api.createPull; let submitted;
  f.api.createPull = async (data) => { submitted = data; await create(data); throw new Error("Response lost"); };
  await assert.rejects(apply(), /Response lost/);
  f.api.createPull = create;
  const result = await apply();
  assert.equal(result.status, "pending-merge"); assert.equal(result.appVerified, false); assert.deepEqual(result.request, { kind: "inspect" });
  assert.equal(submitted.draft, true); assert.match(submitted.body, /Administrator setup.*follow inspection/);
  assert.equal(f.calls.filter(([kind]) => kind === "pr").length, 1);
  assert.ok(f.calls.every(([kind]) => ["tree", "commit", "branch", "pr"].includes(kind)));
  assert.equal(f.rules.length, 0); assert.equal(f.repository.allow_auto_merge, false);
  assert.equal((await f.store.load()).state.factoryApp, undefined);
  assert.match(plan.files[0].content, new RegExp(`factory-runtime.yml@${B}`));
  const before = f.calls.length;
  f.api.fileAt = async (path) => plan.files.find((file) => file.path === path)?.content;
  assert.equal((await apply()).status, "inspection-ready");
  assert.equal(f.calls.length, before);
});

test("bootstrap rejects active callers, changed bases/IDs and altered publication scope before mutation", async () => {
  for (const configure of [
    (f) => { f.api.variable = async () => ({ value: "999" }); },
    (f) => { f.refs.set("main", B); },
    (f) => { f.secretNames.delete("AGENT_APP_PRIVATE_KEY"); },
    (f) => { f.api.fileAt = async () => "jobs:\n  factory:\n    with: {dry-run: false}\n"; },
    (_f, plan) => { plan.files[0].content = plan.files[0].content.replace("dry-run: true", "dry-run: false"); },
    (_f, plan) => { plan.files[1].path = ".github/workflows/other.yml"; },
  ]) {
    const f = fixture(); f.api.variable = async () => ({ value: "123" });
    const plan = bootstrapPlan({ repository: f.repository, configText: "trusted-users: [ntodd]", baseSha: A, appIdCandidate: "123", ciWorkflows: ["CI"], ref: B });
    configure(f, plan);
    await assert.rejects(applyBootstrap({ plan, api: f.api, journal: f.journal }));
    assert.deepEqual(f.calls, []);
  }
});

test("setup cannot silently switch the App recorded in protected state, including in preview", async () => {
  const f = fixture();
  f.state = recordFactoryApp(emptyLedger("42"), { id: "999", login: "other-app[bot]" });
  await assert.rejects(f.apply({ preview: true }), /App changed/);
  await assert.rejects(f.apply(), /App changed/);
  assert.deepEqual(f.calls, []);
});

test("preview does not initialize state, mutate settings, set credentials or write a journal", async () => {
  const f = fixture();
  const result = await f.apply({ preview: true, journal: null, secrets: { OPENAI_API_KEY: "not-in-output" } });
  assert.equal(result.status, "preview");
  assert.deepEqual(f.calls, []); assert.equal(f.rows.size, 0);
  assert.equal(JSON.stringify(result).includes("not-in-output"), false);
});

test("setup checks supplied project secret names and sizes before any mutation, without printing values", async () => {
  const f = fixture();
  f.plan.files[1].content += "\nenvironment: {worker-secrets: [DATABASE_PASSWORD]}\n";
  await assert.rejects(f.apply({ secrets: { SETUP_SECRETS: "OTHER=private-value" } }), /DATABASE_PASSWORD/);
  await assert.rejects(f.apply({ secrets: { SETUP_SECRETS: "GH_TOKEN=private-value" } }), (e) => !e.message.includes("private-value"));
  await assert.rejects(f.apply({ secrets: { SETUP_SECRETS: "DATABASE_PASSWORD=" + "x".repeat(48 * 1024) } }), /48 KiB/);
  assert.deepEqual(f.calls, []);
  const preview = await f.apply({ preview: true, secrets: { SETUP_SECRETS: "DATABASE_PASSWORD=private-value" } });
  assert.equal(preview.status, "preview"); assert.equal(JSON.stringify(preview).includes("private-value"), false);
  assert.deepEqual(f.calls, []);
  const active = fixture({ active: true });
  active.plan.files[1].content += "\nenvironment: {setup-secrets: [PACKAGE_READ_TOKEN]}\n";
  await assert.rejects(active.apply(), /Activation requires SETUP_SECRETS/);
  assert.deepEqual(active.calls, []);
});

test("a lost ruleset-create response is inspected after restart and never creates the ruleset twice", async () => {
  const f = fixture(), original = f.api.createRuleset;
  f.api.createRuleset = async (value) => { await original(value); throw new Error("Response lost after application"); };
  await assert.rejects(f.apply());
  f.api.createRuleset = original;
  await f.apply();
  assert.equal(f.rules.length, 4);
  assert.equal(f.calls.filter(([kind, name]) => kind === "rule-create" && name === "factory-state-writers").length, 1);
});

test("an uncertain ruleset request with no observed effect is retained instead of blindly resubmitted", async () => {
  const f = fixture(); let requests = 0;
  f.api.createRuleset = async () => { requests++; throw new Error("Unknown network outcome"); };
  await assert.rejects(f.apply());
  await assert.rejects(f.apply(), /unknown outcome/);
  assert.equal(requests, 1);
  assert.equal(f.rows.get("ruleset-create:factory-state-writers").status, "pending");
});

test("a lost PR response is recovered from the exact branch and marker", async () => {
  const f = fixture(), original = f.api.createPull;
  f.api.createPull = async (value) => { await original(value); throw new Error("Response lost after creation"); };
  await assert.rejects(f.apply());
  f.api.createPull = original;
  assert.equal((await f.apply()).pr, 19);
  assert.equal(f.calls.filter(([kind]) => kind === "pr").length, 1);
});

test("a setup branch changed after an interrupted write is never overwritten", async () => {
  const f = fixture(), original = f.api.createBranch;
  f.api.createBranch = async (...args) => { await original(...args); throw new Error("Branch response lost"); };
  await assert.rejects(f.apply());
  const branch = [...f.refs.keys()].find((ref) => ref !== "main"); f.refs.set(branch, B);
  f.api.createBranch = original;
  await assert.rejects(f.apply(), /will not be overwritten/);
  assert.equal(f.calls.filter(([kind]) => kind === "branch").length, 1);
});

test("weakened server policy cannot be reported as configured or publish a setup PR", async () => {
  const f = fixture(), original = f.api.createRuleset;
  f.api.createRuleset = async (value) => {
    const result = await original(value);
    if (value.name === "factory-integration") f.rules.at(-1).rules[0].parameters.strict_required_status_checks_policy = false;
    return result;
  };
  await assert.rejects(f.apply(), /protections are not verified/);
  assert.equal(f.calls.some(([kind]) => kind === "pr" || kind === "secret"), false);
});

test("upgrading a managed approval rule preserves stronger review requirements", async () => {
  const f = fixture(), existing = structuredClone(f.plan.rulesets.find((r) => r.name === "factory-approval"));
  existing.id = 99;
  const parameters = existing.rules.find((r) => r.type === "pull_request").parameters;
  parameters.require_last_push_approval = false; parameters.required_approving_review_count = 2;
  parameters.require_code_owner_review = true; existing.rules.push({ type: "required_signatures" });
  f.rules.push(existing); await f.apply();
  const changed = f.rules.find((r) => r.id === 99);
  assert.equal(changed.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count, 2);
  assert.equal(changed.rules.find((r) => r.type === "pull_request").parameters.require_code_owner_review, true);
  assert.equal(changed.rules.some((r) => r.type === "required_signatures"), true);
});

test("activation rejects legacy owners and unrecorded App PRs before any mutation", async () => {
  for (const configure of [
    (f) => { f.api.workflows = async () => [{ id: 1, path: ".github/workflows/agent-ready.yml", state: "active" }]; },
    (f) => { f.api.workflows = async () => [{ id: 1, path: ".github/workflows/agent-ready.yml", state: "disabled_manually" }]; f.api.liveWorkflowRuns = async () => [{ id: 123, status: "queued" }]; },
    (f) => {
      f.api.workflows = async () => [{ id: 2, path: ".github/workflows/agent-ready-caller.yml", state: "active" }];
      f.api.fileAt = async () => "jobs:\n  agent:\n    uses: ntodd/github-actions/.github/workflows/agent-ready.yml@main\n";
    },
    (f) => { f.api.openPulls = async () => [{ number: 7, user: { login: "factory-app[bot]" } }]; },
  ]) {
    const f = fixture({ active: true }); configure(f);
    await assert.rejects(f.apply()); assert.deepEqual(f.calls, []);
  }
});

test("credentials go only to the secret adapter, never the public plan, result or recovery records", async () => {
  const f = fixture(); let supplied;
  f.api.setSecret = async (name, value) => { supplied = value; f.secretNames.add(name); };
  const secret = "private-credential-value", result = await f.apply({ secrets: { OPENAI_API_KEY: secret } });
  assert.equal(supplied, secret);
  assert.equal(JSON.stringify([f.plan, result, [...f.rows.values()]]).includes(secret), false);
  assert.equal(result.warnings.length, 0);
});

test("an additional state-branch restriction cannot be hidden by valid managed rulesets", async () => {
  const f = fixture(), original = f.api.branchRules;
  f.api.branchRules = async () => [...await original(), { type: "pull_request", ruleset_id: 999 }];
  await assert.rejects(f.apply(), /State access policy is not verified/);
  assert.equal(f.calls.some(([kind]) => kind === "pr" || kind === "secret"), false);
});
