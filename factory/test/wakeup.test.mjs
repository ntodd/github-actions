import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wakeReview } from "../lib/wakeup.mjs";
import { callerWorkflow } from "../lib/caller.mjs";
import { parseDocument } from "../vendor/yaml.mjs";

test("the control job rejects controller completions and accepts worker completions", () => {
  const workflow = parseDocument(readFileSync(new URL("../../.github/workflows/factory-runtime.yml", import.meta.url), "utf8")).toJS();
  const accepts = (eventName, path, event) => Function("github", `return (${workflow.jobs.control.if});`)({
    event_name: eventName, event: { workflow_run: { path, event } },
  });
  assert.equal(accepts("workflow_run", ".github/workflows/factory.yml", "workflow_run"), false);
  assert.equal(accepts("workflow_run", ".github/workflows/factory.yml", "workflow_dispatch"), true);
  assert.equal(accepts("workflow_run", ".github/workflows/ci.yml", "push"), true);
  assert.equal(accepts("issue_comment", undefined, undefined), true);
});

test("review wake-ups dispatch only a target hint to the actual default branch", async () => {
  const calls = [];
  const result = await wakeReview({ api: { repository: async () => ({ default_branch: "trunk" }) },
    write: { dispatch: async (...args) => calls.push(args) }, eventName: "pull_request_review_comment",
    event: { pull_request: { number: 19, head: { sha: "untrusted" } }, request: { kind: "worker", operation: "forged" }, comment: { body: "/agent merge" } } });
  assert.equal(result.status, "dispatched");
  assert.deepEqual(calls, [["factory.yml", "trunk", { kind: "reconcile", target: 19 }]]);
});

test("fork dispatch restrictions retain the backstop and do not request privileged secrets", async () => {
  let calls = 0;
  const args = { api: { repository: async () => ({ default_branch: "main" }) },
    write: { dispatch: async () => { calls++; throw Object.assign(new Error("Forbidden"), { status: 403 }); } },
    eventName: "pull_request_review", event: { pull_request: { number: 19 } } };
  assert.equal((await wakeReview(args)).status, "backstop");
  assert.equal(calls, 1);
  await assert.rejects(wakeReview({ ...args, eventName: "workflow_dispatch" }));
  await assert.rejects(wakeReview({ ...args, event: { pull_request: { number: -1 } } }));
});

test("the generated caller separates PR-context wake-ups and secrets-bearing default entry", () => {
  const caller = parseDocument(callerWorkflow({ defaultBranch: "trunk", ciWorkflows: ["CI", "Security"] })).toJS();
  assert.deepEqual(caller.on.push.branches, ["trunk"]);
  assert.deepEqual(caller.on.workflow_run.workflows, ["CI", "Security"]);
  assert.equal(caller.on.schedule[0].cron, "17 * * * *");
  assert.equal(caller.jobs["wake-up"].secrets, undefined);
  assert.equal(caller.jobs["wake-up"].permissions.actions, "write");
  assert.equal(caller.jobs.factory.permissions.actions, "read");
  assert.equal(caller.jobs.factory.with["dry-run"], true);
  assert.equal(caller.jobs.factory.secrets.inherit, undefined);
  assert.equal(caller.jobs.factory.uses, "ntodd/github-actions/.github/workflows/factory-runtime.yml@main");
  assert.ok(Object.values(caller.jobs).every((job) => job.steps === undefined));
  const shared = parseDocument(readFileSync(new URL("../../.github/workflows/factory-wakeup.yml", import.meta.url), "utf8")).toJS();
  assert.equal(shared.on.workflow_call?.secrets, undefined);
  assert.equal(JSON.stringify(shared).includes("secrets."), false);
});

test("worker completion has its own thin caller and neither workflow listens to itself", () => {
  for (const dryRun of [true, false]) {
    const options = { defaultBranch: "main", ciWorkflows: ["CI"], dryRun, attachments: true };
    const main = parseDocument(callerWorkflow(options)).toJS();
    const completion = parseDocument(callerWorkflow({ ...options, completion: true })).toJS();
    assert.equal(main.on.workflow_run.workflows.includes(main.name), false);
    assert.equal(completion.on.workflow_run.workflows.includes(completion.name), false);
    assert.deepEqual(Object.keys(completion.on), ["workflow_run"]);
    assert.deepEqual(completion.on.workflow_run, { workflows: ["factory"], types: ["completed"] });
    assert.deepEqual(Object.keys(completion.jobs), ["factory"]);
    assert.equal(completion.jobs.factory.uses, main.jobs.factory.uses);
    assert.equal(completion.jobs.factory.with["dry-run"], dryRun);
    assert.equal(completion.jobs.factory.with.request, "");
    assert.equal(completion.jobs.factory.with["completion-entry"], true);
    assert.equal(main.jobs.factory.with["completion-entry"], undefined);
    assert.deepEqual(completion.jobs.factory.permissions, main.jobs.factory.permissions);
    assert.deepEqual(completion.jobs.factory.secrets, main.jobs.factory.secrets);
    const accepts = (path, event) => Function("github", `return (${completion.jobs.factory.if});`)({
      event_name: "workflow_run", event: { workflow_run: { path, event } },
    });
    assert.equal(accepts(".github/workflows/factory.yml", "workflow_dispatch"), true);
    assert.equal(accepts(".github/workflows/factory.yml", "workflow_run"), false);
    assert.equal(accepts(".github/workflows/ci.yml", "workflow_dispatch"), false);
    assert.equal(accepts(".github/workflows/factory-completion.yml", "workflow_dispatch"), false);
    assert.ok(Object.values(completion.jobs).every((job) => job.steps === undefined));
  }
});

test("active callers ignore the verified App's status surfaces without suppressing workers or feedback", () => {
  const caller = parseDocument(callerWorkflow({ defaultBranch: "main", ciWorkflows: ["CI"], dryRun: false,
    appLogin: "factory-app[bot]" })).toJS();
  const expression = caller.jobs.factory.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const accepts = (actor, event_name, action) => Function("github", "contains", "fromJSON", `return (${expression});`)(
    { actor, event_name, event: { action } }, (values, value) => values.includes(value), JSON.parse);
  for (const [event, action] of [["issues", "labeled"], ["issues", "closed"], ["issue_comment", "created"],
    ["issue_comment", "edited"], ["pull_request_target", "labeled"], ["pull_request_target", "unlabeled"]]) {
    assert.equal(accepts("factory-app[bot]", event, action), false);
    assert.equal(accepts("ntodd", event, action), true);
    assert.equal(accepts("github-actions[bot]", event, action), true);
    assert.equal(accepts("reviewer[bot]", event, action), true);
  }
  for (const [event, action] of [["workflow_dispatch"], ["workflow_run"], ["push"], ["schedule"],
    ["pull_request_target", "opened"], ["pull_request_target", "synchronize"]]) {
    assert.equal(accepts("factory-app[bot]", event, action), true);
  }
  assert.equal(accepts("ntodd", "pull_request_review", "submitted"), false);
  const review = (actor) => Function("github", "contains", "fromJSON", `return (${caller.jobs["wake-up"].if});`)(
    { actor, event_name: "pull_request_review_comment" }, (values, value) => values.includes(value), JSON.parse);
  assert.equal(review("factory-app[bot]"), false);
  assert.equal(review("reviewer[bot]"), true);
  assert.equal(review("ntodd"), true);
});

test("caller generation rejects YAML/expression injection and missing CI names", () => {
  for (const extra of [{ ciWorkflows: [] }, { ciWorkflows: ["CI\n  malicious: true"] }, { ciWorkflows: ["${{ secrets.KEY }}"] },
    { defaultBranch: "main\nother: true" }, { ref: "main@other" }, { toolingRepository: "owner/repo\nother" },
    { ciWorkflows: ["factory"] }, { ciWorkflows: ["factory completion"] }, { completion: "true" },
    { appLogin: "bad' || true" }, { appLogin: "ntodd" }]) {
    assert.throws(() => callerWorkflow({ defaultBranch: "main", ciWorkflows: ["CI"], ...extra }));
  }
});

test("attachment credentials are forwarded only to the trusted entry and stay out of Crew/update jobs", () => {
  const args = { defaultBranch: "main", ciWorkflows: ["CI"] };
  const old = parseDocument(callerWorkflow(args)).toJS(), current = parseDocument(callerWorkflow({ ...args, attachments: true })).toJS();
  assert.equal(old.jobs.factory.secrets.AGENT_ATTACH_TOKEN, undefined);
  assert.equal(current.jobs.factory.secrets.AGENT_ATTACH_TOKEN, "${{ secrets.AGENT_ATTACH_TOKEN }}");
  assert.equal(current.jobs["wake-up"].secrets, undefined);
  const shared = parseDocument(readFileSync(new URL("../../.github/workflows/factory-runtime.yml", import.meta.url), "utf8")).toJS();
  assert.deepEqual(shared.on.workflow_call.secrets.AGENT_ATTACH_TOKEN, { required: false });
  assert.equal(shared.jobs.control.steps.find((s) => s.id === "control").env.AGENT_ATTACH_TOKEN, "${{ secrets.AGENT_ATTACH_TOKEN }}");
  for (const role of ["worker", "update"]) assert.equal(JSON.stringify(shared.jobs[role]).includes("AGENT_ATTACH_TOKEN"), false);
});
