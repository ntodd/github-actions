import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../vendor/yaml.mjs";
import { setupRulesets, verifySetupRulesets, setupPlan } from "../lib/setup.mjs";

const checks = [{ context: "test", integration_id: 15368 }];
const app = { id: 123, slug: "ntodd-agent", permissions: { contents: "write", issues: "write", pull_requests: "write",
  actions: "write", checks: "read", statuses: "read" } };
const repository = { id: 42, full_name: "ntodd/project", default_branch: "trunk", permissions: { admin: true } };
const args = { repository, app, configText: "trusted-users: [ntodd]", checks, ciWorkflows: ["CI"] };

test("state writers can update without bypassing the separate deletion/force-push restrictions", () => {
  const rules = setupRulesets(app.id, checks);
  const writers = rules.find((r) => r.name === "factory-state-writers"), history = rules.find((r) => r.name === "factory-state-history");
  assert.deepEqual(writers.bypass_actors.map((a) => [a.actor_type, a.actor_id]), [["Integration", 123], ["RepositoryRole", 5]]);
  assert.deepEqual(writers.rules.map((r) => r.type), ["creation", "update"]);
  assert.deepEqual(history.bypass_actors, []);
  assert.deepEqual(history.rules.map((r) => r.type), ["deletion", "non_fast_forward"]);
});

test("strict integration has no admin bypass while latest-push approval retains its separate admin exemption", () => {
  const rules = setupRulesets(app.id, checks);
  const integration = rules.find((r) => r.name === "factory-integration"), approval = rules.find((r) => r.name === "factory-approval");
  assert.deepEqual(integration.bypass_actors, []);
  assert.equal(integration.rules[0].parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(integration.rules[0].parameters.required_status_checks, checks);
  assert.equal(approval.rules.find((r) => r.type === "pull_request").parameters.require_last_push_approval, true);
  assert.deepEqual(approval.bypass_actors, [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "exempt" }]);
});

test("verification rejects weakened server policy, omitted bypass metadata and wrong check identity", () => {
  const expected = setupRulesets(app.id, checks);
  assert.equal(verifySetupRulesets(structuredClone(expected), expected).valid, true);
  const mutations = [
    (r) => { r[0].bypass_actors.push({ actor_type: "RepositoryRole", actor_id: 4, bypass_mode: "always" }); },
    (r) => { r[1].bypass_actors = r[0].bypass_actors; },
    (r) => { delete r[1].bypass_actors; }, (r) => { r[1].rules.pop(); },
    (r) => { r[2].rules[2].parameters.require_last_push_approval = false; },
    (r) => { r[2].rules[2].parameters.required_approving_review_count = 0; },
    (r) => { r[3].rules[0].parameters.strict_required_status_checks_policy = false; },
    (r) => { r[3].rules[0].parameters.required_status_checks[0].integration_id = 999; },
    (r) => { r[3].bypass_actors = r[2].bypass_actors; },
    (r) => { r[3].conditions.ref_name.exclude = ["refs/heads/trunk"]; },
    (r) => { r[3].enforcement = "evaluate"; }, (r) => { r.push(structuredClone(r[3])); },
  ];
  for (const mutate of mutations) {
    const actual = structuredClone(expected); mutate(actual);
    assert.equal(verifySetupRulesets(actual, expected).valid, false);
  }
  const stronger = structuredClone(expected); stronger[2].rules[2].parameters.required_approving_review_count = 2;
  stronger[2].rules[2].parameters.require_code_owner_review = true;
  assert.equal(verifySetupRulesets(stronger, expected).valid, true);
});

test("state writer verification accepts GitHub's omitted false update option but rejects upstream updates", () => {
  const expected = setupRulesets(app.id, checks), observed = structuredClone(expected);
  delete observed[0].rules.find((r) => r.type === "update").parameters;
  assert.equal(verifySetupRulesets(observed, expected).valid, true);
  observed[0].rules.find((r) => r.type === "update").parameters = { update_allows_fetch_and_merge: true };
  assert.equal(verifySetupRulesets(observed, expected).valid, false);
});

test("the setup plan produces a read-only thin caller, strict protections and only public configuration", () => {
  const plan = setupPlan(args), caller = parseDocument(plan.files[0].content).toJS();
  assert.equal(plan.mode, "read-only");
  assert.equal(caller.jobs.factory.with["dry-run"], true);
  assert.deepEqual(caller.on.push.branches, ["trunk"]);
  assert.equal(plan.files[1].path, ".github/factory.yml");
  assert.equal(plan.files[2].path, ".github/workflows/factory-completion.yml");
  const completion = parseDocument(plan.files[2].content).toJS();
  assert.equal(completion.jobs.factory.with["dry-run"], true);
  assert.deepEqual(completion.on.workflow_run.workflows, [caller.name]);
  assert.equal(caller.on.workflow_run.workflows.includes(caller.name), false);
  assert.equal(plan.stateBranch, "factory-state");
  assert.equal(plan.settings.allow_auto_merge, true);
  assert.deepEqual(plan.variable, { name: "AGENT_APP_ID", value: "123" });
  assert.equal(plan.labels.length, 14);
  assert.equal(JSON.stringify(plan).includes("PRIVATE KEY"), false);
});

test("setup refuses an overprivileged App, self-review policy, missing checks and non-admin access", () => {
  for (const change of [
    { app: { ...app, permissions: { ...app.permissions, administration: "write" } } },
    { app: { ...app, permissions: { ...app.permissions, workflows: "write" } } },
    { configText: "trusted-users: [ntodd]\nreview-bots: ['ntodd-agent[bot]']" },
    { checks: [] }, { checks: [{ context: "test" }, { context: "test" }] },
    { repository: { ...repository, permissions: { admin: false } } }, { repository: { ...repository, archived: true } },
  ]) assert.throws(() => setupPlan({ ...args, ...change }));
});
