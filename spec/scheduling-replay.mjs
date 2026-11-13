// Check the queue model's admission decisions against generated Actions YAML,
// and its durable projection against the real reducer and reconcile table.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { callerWorkflow } from "../factory/lib/caller.mjs";
import { controllerWakeup } from "../factory/lib/entry.mjs";
import { parseDocument } from "../factory/vendor/yaml.mjs";
import { admit, emptyLedger, evolve, revisionOf } from "../factory/lib/protocol.mjs";
import { decideItem } from "../factory/lib/reconcile.mjs";
import { parseConfig } from "../factory/lib/config.mjs";

export function replayScheduling({ dir, run, decode }) {
  const options = { defaultBranch: "main", ciWorkflows: ["CI"], dryRun: false, appLogin: "factory-app[bot]" };
  const primary = parseDocument(callerWorkflow(options)).toJS();
  const completion = parseDocument(callerWorkflow({ ...options, completion: true })).toJS();
  const shared = parseDocument(readFileSync(new URL("../.github/workflows/factory-runtime.yml", import.meta.url), "utf8")).toJS();
  assert.equal(shared.jobs.control.concurrency.group, "factory-control");
  assert.equal(shared.jobs.control.concurrency["cancel-in-progress"], false);
  assert.equal(shared.jobs.control.concurrency.queue, "max", "The queue model requires Actions' 100 pending slots");
  const capacity = 100;
  for (const workflow of [primary, completion]) assert(!workflow.on.workflow_run.workflows.includes(workflow.name), "A workflow cannot listen to itself");
  assert(primary.on.schedule.length > 0, "Recovery requires the independent backstop");

  const evaluate = (expression, github, inputs = {}) => Function("github", "inputs", "contains", "fromJSON",
    `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")});`)(github, inputs, (values, value) => values.includes(value), JSON.parse);
  const title = (kind) => evaluate(primary["run-name"], { event_name: "workflow_dispatch" }, { request: JSON.stringify({ kind }) });
  const events = {
    human: { event_name: "issue_comment", actor: "ntodd", event: { action: "created" } },
    ci: { event_name: "workflow_run", event: { workflow_run: { name: "CI", path: ".github/workflows/ci.yml", event: "push" } } },
    backstop: { event_name: "schedule", event: {} },
    "review-hint": { event_name: "workflow_dispatch", event: {} },
    "app-pr-opened": { event_name: "pull_request_target", actor: options.appLogin, event: { action: "opened" } },
    "app-comment": { event_name: "issue_comment", actor: options.appLogin, event: { action: "created" } },
    "app-label": { event_name: "pull_request_target", actor: options.appLogin, event: { action: "labeled" } },
    "app-review": { event_name: "pull_request_review_comment", actor: options.appLogin, event: { action: "created" } },
    "worker-completion": { event_name: "workflow_run", event: { workflow_run: { name: "factory", path: ".github/workflows/factory.yml", event: "workflow_dispatch", display_title: title("worker") } } },
    "controller-completion": { event_name: "workflow_run", event: { workflow_run: { name: "factory", path: ".github/workflows/factory.yml", event: "workflow_run", display_title: title("reconcile") } } },
    "inspect-completion": { event_name: "workflow_run", event: { workflow_run: { name: "factory", path: ".github/workflows/factory.yml", event: "workflow_dispatch", display_title: title("inspect") } } },
    "collector-completion": { event_name: "workflow_run", event: { workflow_run: { name: "factory completion", path: ".github/workflows/factory-completion.yml", event: "workflow_run", display_title: "factory completion" } } },
  };
  function routed(kind) {
    const github = events[kind];
    assert(github, `Unmapped model event ${kind}`);
    return [primary, completion].some((workflow) => {
      if (!Object.hasOwn(workflow.on, github.event_name)) return false;
      if (github.event_name === "workflow_run" && !workflow.on.workflow_run.workflows.includes(github.event.workflow_run.name)) return false;
      // A review hop dispatches a reconcile hint; it has its own pre-job filter.
      if (workflow.jobs["wake-up"] && evaluate(workflow.jobs["wake-up"].if, github)) return true;
      const admitted = evaluate(workflow.jobs.factory.if, github) && evaluate(shared.jobs.control.if, github);
      if (admitted) assert(controllerWakeup(github.event_name, github.event), "Node and job-level completion guards disagree");
      return Boolean(admitted);
    });
  }

  const directory = join(dir, "scheduling");
  mkdirSync(directory);
  run(["test", "spec/scheduling.qnt", "--backend=rust", "--max-samples=1", "--seed=20261111", `--out-itf=${directory}/{test}-{seq}.json`]);
  run(["run", "spec/scheduling.qnt", "--backend=rust", "--invariant=safety", "--max-samples=25", "--n-traces=25", "--max-steps=100",
    "--n-threads=1", "--seed=20261111", `--out-itf=${directory}/sample-{seq}.json`, "--verbosity=0"]);
  const sha = "a".repeat(40), head = "b".repeat(40), commit = "c".repeat(40);
  const revision = revisionOf({ title: "Accepted issue" });
  const config = parseConfig("trusted-users: [ntodd]");
  const observation = { authorization: { valid: true, revision }, head, baseSha: sha, open: true };
  const provenance = { repositoryId: "42", workflowPath: ".github/workflows/factory.yml", headSha: sha };
  const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  let transitions = 0;
  const checkedEvents = new Set();
  for (const file of files) {
    const frames = JSON.parse(readFileSync(join(directory, file), "utf8")).states;
    const states = frames.filter((frame, index) => {
      if (Object.hasOwn(frame, "s")) return true;
      assert.equal(index, frames.length - 1);
      assert.deepEqual(Object.keys(frame), ["#meta"]);
      return false;
    }).map((frame) => decode(frame.s));
    let ledger = admit(emptyLedger("42"), { key: "issue:7", revision, evidence: { sourceId: "label:1" },
      prs: [{ number: 1, required: true, state: "open", mergedSha: null, acceptedClosure: false }] });
    let minute = 0;
    const at = () => new Date(Date.UTC(2026, 10, 12, 12, minute)).toISOString();
    const update = (event) => { ledger = evolve(ledger, "issue:7", { at: at(), operationId: "op-1", ...event }); };
    update({ type: "reserve", id: "op-1", mode: "respond", revision, toolingSha: sha, configSha: sha,
      target: { number: 1, branch: "factory/pr-1", head }, base: { ref: "main", sha } });
    function plan(state) {
      const owner = state.owner ? { id: String(state.owner), attempt: 1, status: state.workerDone ? "completed" : "queued", conclusion: state.workerDone ? "success" : null } : null;
      return decideItem(ledger, "issue:7", { authorization: observation.authorization, issueState: "open",
        prs: [{ number: 1, state: "open", headSha: head, baseSha: sha, baseRef: "main" }],
        main: { ref: "main", sha }, owner, result: { available: state.workerDone, inspected: state.workerDone } }, config, { now: at() });
    }
    function applyPlan(decision) { for (const event of decision.events) update(event); }
    for (let i = 1; i < states.length; i++) {
      const before = states[i - 1], state = states[i];
      try {
        let active = before.active, pending = [...before.pending];
        const enqueue = (job) => {
          if (active.kind === "none") active = job;
          else if (pending.length < capacity) pending.push(job);
        };
        if (state.lastAction === "arrive" && state.accepted) enqueue({ kind: state.event, id: 0 });
        if (state.lastAction === "deliver") enqueue({ kind: "worker", id: state.runId });
        if (state.lastAction === "batch-workers") for (const id of [1, 2, 3, 4]) enqueue({ kind: "worker", id });
        if (state.lastAction === "fill-queue") for (let n = 0; n < capacity; n++) enqueue({ kind: "human", id: 0 });
        if (["finish-control", "crash-control"].includes(state.lastAction)) active = pending.shift() ?? { kind: "none", id: 0 };
        if (state.lastAction === "cancel-pending") pending.shift();
        assert.deepEqual(state.active, active);
        assert.deepEqual(state.pending, pending);
        if (state.lastAction === "arrive") {
          assert.equal(routed(state.event), state.accepted, `Workflow routing disagrees for ${state.event}`);
          checkedEvents.add(state.event);
        } else if (state.lastAction === "backoff-elapsed") minute += 5;
        else if (state.lastAction === "dispatch") {
          const decision = plan(before);
          assert.equal(decision.action?.type, "dispatch");
          applyPlan(decision);
          update({ type: "dispatch-request" });
        } else if (state.lastAction === "claim") update({ type: "claim", run: { id: String(state.owner), attempt: 1 }, provenance, observation });
        else if (state.lastAction === "ask") {
          const decision = plan(before);
          assert.equal(decision.action?.type, "ask");
          assert.match(decision.action.reason, /Dispatch attempts were exhausted/);
          applyPlan(decision);
        } else if (state.lastAction === "collect") {
          const decision = plan(before), identity = { id: String(state.owner), attempt: 1 };
          assert.equal(decision.action?.type, "collect-result");
          applyPlan(decision);
          update({ type: "collect-result", artifact: { id: "200", run: identity, ...provenance, digest: `sha256:${"e".repeat(64)}`, expired: false },
            proposal: { schemaVersion: 1, operationId: "op-1", run: identity, outcome: "ready", effects: [
              { id: "push", type: "push", branch: "factory/pr-1", expectedHead: head, commit, baseSha: sha },
            ] } });
        }
        const op = ledger.operations["op-1"];
        assert.equal(op.phase, state.phase);
        assert.equal(op.owner?.id ?? "0", String(state.owner));
        assert.equal(op.dispatch?.attempts.length ?? 0, state.requests);
        assert.equal(Boolean(ledger.items["issue:7"].question), state.asked);
        assert.equal(ledger.items["issue:7"].attempts.length, 1, "Lost delivery must not spend another coding reservation");
        if (state.phase === "prepared" && !state.asked) {
          const decision = plan(state);
          assert.equal(decision.action?.type ?? "wait", state.requests === 3 ? "ask" : state.due ? "dispatch" : "wait");
        }
        if (state.active.kind === "worker" && state.asked) assert.throws(() => evolve(ledger, "issue:7", {
          type: "claim", operationId: "op-1", at: at(), run: { id: String(state.active.id), attempt: 1 }, provenance, observation,
        }), (error) => error.code === "stale", "A late delivery must not bypass the dispatch-exhaustion question");
      } catch (error) {
        throw new Error(`${file}, transition ${i}, ${state.lastAction}: ${error.message}`, { cause: error });
      }
      transitions++;
    }
  }
  assert.deepEqual([...checkedEvents].sort(), Object.keys(events).sort(), "Every routing class needs replay coverage");
  console.log(`Replayed ${files.length} scheduling traces and ${transitions} transitions through generated workflow filters, the reconciler and operation protocol.`);
}
