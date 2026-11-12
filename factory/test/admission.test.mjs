import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, withFactoryApp } from "../lib/config.mjs";
import { authorizeIssue, authorizeOwnPr, classifyText, classifyLabel, parseCommand, sourceMarker, readFeedback, inspectIssue, inspectOwnPr } from "../lib/admission.mjs";
const config = parseConfig("trusted-users: [ntodd]\nproducers: [flake-hunt, main-red]\nreview-bots: [reviewer[bot]]".replace("[reviewer[bot]]", "['reviewer[bot]']"));
const issue = { number: 7, title: "Fix it", body: "Task", state: "open", user: { login: "ntodd" }, labels: [{ name: "agent-ready" }] };
const label = { id: 10, event: "labeled", created_at: "2026-11-12T00:00:00Z", label: { name: "agent-ready" }, actor: { login: "ntodd" } };
const comment = (id, body, login = "ntodd") => ({ id, body, user: { login }, created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z" });
const auth = (over = {}) => authorizeIssue({ issue, editors: [], events: [label], config, ...over });

test("admission follows original trusted evidence across relabels and status changes", () => {
  const first = auth();
  assert.equal(first.valid, true);
  const unlabeled = { ...issue, labels: [] };
  assert.equal(auth({ issue: unlabeled }).valid, false);
  assert.equal(auth({ issue: unlabeled, evidence: first.evidence, events: [label, { ...label, id: 11, actor: { login: "ntodd-agent[bot]" } }] }).valid, true);
  assert.equal(auth({ events: [{ ...label, actor: { login: "ntodd-agent[bot]" } }] }).valid, false);
  assert.equal(auth({ editors: ["ntodd-agent[bot]"] }).valid, false);
  assert.equal(auth({ editors: undefined }).valid, false);
});

test("producer markers require bot authorship, registered source, trusted edits and a valid labeler", () => {
  const bot = "github-actions[bot]";
  const producer = { ...issue, body: "Observed failure\n<!-- agent-ready:source=main-red key=compile -->", user: { login: bot } };
  const admitted = auth({ issue: producer, events: [{ ...label, actor: { login: bot } }], editors: [bot] });
  assert.equal(admitted.valid, true);
  assert.equal(admitted.producer.source, "main-red");
  for (const mutation of [
    { user: { login: "outsider" } }, { body: "<!-- agent-ready:source=unknown key=test -->" },
    { body: `${producer.body}\nNot a trailing marker` },
  ]) assert.equal(auth({ issue: { ...producer, ...mutation } }).valid, false);
  assert.equal(auth({ issue: producer, editors: ["outsider"] }).valid, false);
  assert.equal(sourceMarker("<!-- flake-hunt:mix-test-key -->").source, "flake-hunt");
});

test("an explicit build command can authorize unlabeled work, but edited commands and routing cannot", () => {
  const cmd = comment(20, "/agent build fix the race");
  const first = auth({ issue: { ...issue, labels: [] }, events: [], comments: [cmd], commandId: "issue-comment:20" });
  assert.equal(first.valid, true);
  assert.equal(auth({ comments: [{ ...cmd, updated_at: "2026-11-12T00:01:00Z" }], evidence: first.evidence }).valid, false);
  for (const body of ["/agent status", "@ntodd-agent fix this", "/agent resolve"]) assert.equal(auth({ comments: [comment(20, body)], commandId: "issue-comment:20" }).valid, false);
});

test("fresh reads, not payload comments, establish issue authorization", async () => {
  const calls = [];
  const api = { issue: async () => { calls.push("issue"); return issue; }, editors: async () => { calls.push("editors"); return []; },
    events: async () => { calls.push("events"); return [label]; }, comments: async () => { calls.push("comments"); return []; } };
  assert.equal((await inspectIssue(api, 7, config)).valid, true);
  assert.deepEqual(calls.sort(), ["comments", "editors", "events", "issue"]);
});

test("exact commands are deterministic and mentions respect handle boundaries", () => {
  assert.equal(parseCommand("/resolve", config.handle).action, "resolve");
  assert.equal(parseCommand("/agent stop", config.handle).action, "stop");
  assert.equal(parseCommand("/effort MAX", config.handle).effort, "max");
  assert.equal(parseCommand("/agent merge", config.handle).action, "clarify");
  assert.equal(parseCommand("@ntodd-agent go with 1", config.handle).action, "route");
  for (const text of ["ordinary discussion", "@ntodd-agent-extra fix", "mail@ntodd-agent", "@@ntodd-agent"]) assert.equal(parseCommand(text, config.handle), null);
});

test("trusted unedited text is instructions; configured bot reviews remain signals", () => {
  assert.equal(classifyText(comment(1, "/agent stop"), "issue-comment", config).command.action, "stop");
  assert.equal(classifyText(comment(1, "/agent stop", "outsider"), "issue-comment", config).command, null);
  assert.equal(classifyText({ ...comment(1, "/agent stop"), updated_at: "edited" }, "issue-comment", config).authority, "data");
  assert.equal(classifyText(comment(1, "/agent stop", "reviewer[bot]"), "review-comment", config).authority, "signal");
  assert.equal(classifyText({ id: 1, body: "fix", author: "ntodd", lastEditedAt: null }, "review-comment", config).authority, "instruction");
});

test("a review bot's exact login cannot authorize a similarly named human", () => {
  for (const kind of ["issue-comment", "review"]) {
    assert.equal(classifyText(comment(1, "fix", "reviewer"), kind, config).authority, "data");
    assert.equal(classifyText(comment(1, "fix", "reviewer[bot]"), kind, config).authority, "signal");
  }
});

test("the verified factory App is always data even when configured as a review bot or accidentally trusted", () => {
  const identity = "actual-factory[bot]";
  const bound = { ...withFactoryApp(parseConfig("trusted-users: [ntodd]\nhandle: unrelated\nreview-bots: ['actual-factory[bot]', 'reviewer[bot]']"), identity),
    trustedUsers: ["ntodd", identity] };
  for (const kind of ["issue-comment", "review-comment", "review"]) {
    const fact = classifyText(comment(1, "/agent restart", identity), kind, bound);
    assert.equal(fact.authority, "data");
    assert.equal(fact.command, null);
    assert.equal(fact.trustedAuthor, false);
  }
  assert.equal(classifyText(comment(2, "scan finding", "reviewer[bot]"), "review-comment", bound).authority, "signal");
  assert.equal(classifyLabel({ ...label, actor: { login: identity } }, bound, 7), null);
  assert.equal(auth({ config: bound, issue: { ...issue, user: { login: identity } } }).valid, false);
  assert.equal(auth({ config: bound, editors: [identity] }).valid, false);
});

test("feedback includes every thread comment and review, with stable revision IDs", async () => {
  const api = { events: async () => [], comments: async (n) => [comment(n, `conversation ${n}`)],
    reviews: async () => [{ id: 30, body: "changes", author: "ntodd", state: "CHANGES_REQUESTED", lastEditedAt: null, commitSha: "a".repeat(40) }],
    threads: async () => [{ id: "thread-1", comments: [comment(40, "first"), comment(41, "/agent respond fix fixture")] }] };
  const feedback = await readFeedback(api, { issue: 7, prs: [9] }, config);
  assert.equal(feedback.length, 5);
  assert.equal(feedback.find((f) => f.sourceId === "review-comment:41").command.action, "respond");
  assert.equal(feedback.find((f) => f.sourceId === "review:30").state, "CHANGES_REQUESTED");
  assert.notEqual(classifyText(comment(1, "before"), "issue-comment", config).revision, classifyText(comment(1, "after"), "issue-comment", config).revision);
});

test("own PR maintenance needs an explicit authorized update/resolve and never enrolls a fork", () => {
  const pr = { number: 9, title: "Own fix", body: "Intent", state: "open", user: { login: "ntodd" }, head: { repo: { full_name: "ntodd/repo" } }, base: { ref: "trunk" } };
  const args = { pr, editors: [], comments: [comment(20, "/agent resolve")], commandId: "issue-comment:20", config, repo: "ntodd/repo", defaultBranch: "trunk" };
  assert.equal(authorizeOwnPr(args).valid, true);
  assert.equal(authorizeOwnPr({ ...args, pr: { ...pr, head: { repo: { full_name: "fork/repo" } } } }).valid, false);
  assert.equal(authorizeOwnPr({ ...args, comments: [comment(20, "/agent restart")] }).valid, false);
});

test("trusted edit history permits updated review instructions but never edited commands", () => {
  const edited = { id: 90, body: "/agent stop", author: "ntodd", lastEditedAt: "2026-11-12T00:01:00Z", editors: ["ntodd"] };
  assert.equal(classifyText(edited, "review", config).authority, "instruction");
  assert.equal(classifyText(edited, "review-comment", config).command, null);
  assert.equal(classifyText({ ...edited, editors: ["ntodd-agent[bot]"] }, "review", config).authority, "data");
});

test("label shortcuts use immutable timeline identities and only trusted human labelers", () => {
  const event = { ...label, created_at: "2026-11-12T12:00:00Z" };
  assert.equal(classifyLabel(event, config, 7).command.action, "build");
  assert.equal(classifyLabel({ ...event, label: { name: "effort:high" } }, config, 7).command.effort, "high");
  for (const mutation of [{ actor: { login: "ntodd-agent[bot]" } }, { actor: { login: "github-actions[bot]" } },
    { actor: { login: "outsider" } }, { event: "unlabeled" }, { label: { name: "agent-working" } }, { label: { name: "effort:unknown" } }]) {
    assert.equal(classifyLabel({ ...event, ...mutation }, config, 7), null);
  }
  assert.throws(() => classifyLabel({ ...event, created_at: undefined }, config, 7));
});

test("an initial mention is a durable request, and only its recorded work action can authorize admission", () => {
  const args = { issue: { ...issue, labels: [] }, events: [], comments: [comment(20, "@ntodd-agent fix the race")], commandId: "issue-comment:20" };
  const request = auth({ ...args, allowRequest: true });
  assert.equal(request.valid, false);
  assert.equal(request.requestValid, true);
  assert.equal(request.evidence.kind, "request");
  assert.equal(auth({ ...args, evidence: request.evidence }).valid, false);
  const evidence = { ...request.evidence, kind: "routed-command", action: "build" };
  assert.equal(auth({ ...args, evidence }).valid, true);
  assert.equal(auth({ ...args, evidence: { ...evidence, action: "respond" } }).valid, false);
  assert.equal(auth({ ...args, evidence, comments: [comment(20, "edited body")] }).valid, false);
  assert.equal(auth({ ...args, evidence, editors: ["outsider"] }).valid, false);
});

test("first own-PR requests can come from a thread, but preserve author, editor and repository boundaries", async () => {
  const pr = { number: 9, title: "My fix", body: "Scope", state: "open", user: { login: "ntodd" },
    head: { repo: { full_name: "ntodd/project" } }, base: { ref: "main" } };
  const rows = [comment(20, "@ntodd-agent rebase this")];
  const api = { pull: async () => pr, comments: async () => [], editors: async () => [],
    threads: async () => [{ id: "T1", comments: rows }] };
  const context = { repo: "ntodd/project", defaultBranch: "main", config };
  const request = await inspectOwnPr(api, 9, context, { commandId: "review-comment:20", allowRequest: true });
  assert.equal(request.valid, false);
  assert.equal(request.requestValid, true);
  const evidence = { ...request.evidence, kind: "routed-command", action: "update" };
  assert.equal((await inspectOwnPr(api, 9, context, { evidence })).valid, true);
  assert.equal((await inspectOwnPr(api, 9, context, { evidence: { ...evidence, action: "build" } })).valid, false);
  rows[0].updated_at = "2026-11-12T12:01:00Z";
  assert.equal((await inspectOwnPr(api, 9, context, { evidence })).valid, false);
});
