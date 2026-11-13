import { test } from "node:test";
import assert from "node:assert/strict";
import { writeClient } from "../lib/github-write.mjs";
import { actionsClient } from "../lib/actions.mjs";
import { validateLedger } from "../lib/protocol.mjs";
import { decideItem } from "../lib/reconcile.mjs";
import { ingestCommands } from "../lib/commands.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, reserve, step, operation, at, run, provenance, observation, revision, A, B } from "./fixtures.mjs";

const deadline = "2026-11-12T12:30:00.000Z", later = "2026-11-12T12:15:00.000Z";
const config = parseConfig("trusted-users: [ntodd]");
function prepared() {
  const state = step(step(initial(), reserve()), { type: "dispatch-request" });
  Object.assign(operation(state).dispatch.attempts[0], { run, deadline });
  return state;
}
const facts = (status = "queued") => ({ authorization: observation.authorization, issueState: "open", feedback: [],
  prs: [{ number: 9, state: "open", headSha: B, baseSha: A }], dispatchRuns: [{ ...run, status }] });
const decide = (state, observed, now = later) => decideItem(state, "issue:7", observed, config, { now });

test("dispatch retains the run identity returned by the newer GitHub API", async () => {
  const calls = [];
  const api = writeClient({ token: "secret", repo: "ntodd/project", fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ workflow_run_id: 100, run_url: "https://api.github.com/repos/ntodd/project/actions/runs/100",
      html_url: "https://github.com/ntodd/project/actions/runs/100" });
  } });
  assert.deepEqual(await api.dispatch("factory.yml", "main", { kind: "worker", item: "issue:7", operation: "op-1" }), run);
  assert.equal(calls[0].options.headers["x-github-api-version"], "2026-03-10");
  assert.equal(calls.length, 1);
  const invalid = writeClient({ token: "secret", repo: "ntodd/project", fetch: async () => Response.json({ workflow_run_id: 0 }) });
  await assert.rejects(invalid.dispatch("factory.yml", "main", { kind: "reconcile" }), /dispatch|identity/i);
  const legacy = writeClient({ token: "secret", repo: "ntodd/project", apiUrl: "https://ghe.example/api/v3", fetch: async (_url, options) => {
    assert.equal(options.headers["x-github-api-version"], "2022-11-28");
    return new Response(null, { status: 204 });
  } });
  assert.equal(await legacy.dispatch("factory.yml", "main", { kind: "reconcile" }), null);
});

test("a dispatch receipt binds one reserved request and is immutable", () => {
  let state = step(step(initial(), reserve()), { type: "dispatch-request" });
  const accepted = { type: "dispatch-accepted", request: 1, run, deadline };
  state = step(state, accepted);
  assert.deepEqual(operation(state).dispatch.attempts[0].run, run);
  assert.deepEqual(step(state, accepted), state);
  assert.throws(() => step(state, { ...accepted, run: { id: "101", attempt: 1 } }), (e) => e.code === "stale");
  assert.throws(() => step(state, { ...accepted, request: 2 }), (e) => e.code === "stale");
  const corrupt = structuredClone(state);
  delete operation(corrupt).dispatch.attempts[0].deadline;
  assert.throws(() => validateLedger(corrupt), (e) => e.code === "corrupt");
  assert.throws(() => step(step(initial(), reserve()), accepted), (e) => e.code === "stale");
});

test("known queued and running dispatches outlive redispatch backoff without spending another request", () => {
  for (const status of ["queued", "in_progress"]) {
    const state = prepared(), plan = decide(state, facts(status));
    assert.equal(plan.action, null);
    assert.match(plan.status.reason, /dispatched.*waiting|waiting.*claim/i);
    assert.equal(plan.status.wait.deadline, deadline);
    assert.equal(operation(state).dispatch.attempts.length, 1);
  }
  assert.equal(decide(prepared(), facts("completed")).action.type, "dispatch");
  assert.equal(decide(prepared(), { ...facts(), dispatchRuns: undefined }).action, null);
});

test("an acknowledged third dispatch waits for its live run instead of asking exhaustion", () => {
  let state = step(initial(), reserve());
  for (const time of [at, "2026-11-12T12:05:00Z", "2026-11-12T12:10:00Z"]) state = step(state, { type: "dispatch-request", at: time });
  Object.assign(operation(state).dispatch.attempts[2], { run, deadline });
  assert.equal(decide(state, facts()).action, null);
  assert.equal(decide(state, facts("completed")).action.type, "ask");
});

test("an expired unclaimed delivery asks once and explicit retry fences the old queued claim", () => {
  let state = prepared();
  const now = "2026-11-12T12:31:00.000Z", question = decide(state, facts(), now);
  assert.equal(question.action.type, "ask");
  assert.match(question.action.reason, /claim.*deadline|deadline.*claim/i);
  for (const event of question.events) state = step(state, event);
  assert.equal(decide(state, facts(), now).events.some((e) => e.type === "ask"), false);
  state = ingestCommands(state, "issue:7", [{ authority: "instruction", sourceId: "issue-comment:998", revision,
    author: "ntodd", createdAt: now, target: 9, command: { action: "retry", text: "" } }]);
  const retry = decide(state, facts(), now);
  assert.equal(retry.action.type, "reserve");
  for (const event of retry.events) state = step(state, event);
  assert.equal(operation(state).phase, "superseded");
  assert.throws(() => step(state, { type: "claim", run, provenance, observation }), (e) => e.code === "claimed");
  assert.throws(() => step(prepared(), { type: "abandon-prepared", commandId: "missing", at: now }));
});

test("dispatch observation verifies every known run's original attempt and provenance", async () => {
  for (const change of [{}, { head_sha: B }, { run_attempt: 2 }, { repository: { id: 99 } }, { path: ".github/workflows/other.yml" }]) {
    const calls = [], api = actionsClient({ token: "secret", repo: "ntodd/project", fetch: async (url) => {
      calls.push(url);
      return Response.json({ id: 100, run_attempt: 1, repository: { id: 42 }, head_repository: { id: 42 },
        path: ".github/workflows/factory.yml", head_sha: A, head_branch: "main", event: "workflow_dispatch", status: "pending", ...change });
    } });
    const read = () => api.dispatched(operation(prepared()), { repositoryId: "42" });
    if (Object.keys(change).length) await assert.rejects(read, /provenance/);
    else assert.deepEqual((await read()).map(({ id, attempt, status }) => ({ id, attempt, status })), [{ ...run, status: "queued" }]);
    assert.deepEqual(calls, ["https://api.github.com/repos/ntodd/project/actions/runs/100/attempts/1"]);
  }
});
