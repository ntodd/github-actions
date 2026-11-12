import { test } from "node:test";
import assert from "node:assert/strict";
import { writeClient } from "../lib/github-write.mjs";
function fixture(handler) {
  const calls = [];
  const api = writeClient({ token: "private-token", repo: "ntodd/project", fetch: async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  } });
  return { api, calls };
}
test("reaction endpoints distinguish conversation and review comments and reject injected identities", async () => {
  const f = fixture(() => Response.json({ id: 1, content: "eyes" }));
  await f.api.react("issue-comment", 12, "eyes"); await f.api.react("review-comment", 34, "eyes");
  assert.ok(f.calls[0].url.endsWith("/issues/comments/12/reactions"));
  assert.ok(f.calls[1].url.endsWith("/pulls/comments/34/reactions"));
  await assert.rejects(() => f.api.react("issue-comment", "12/../../pulls", "eyes"), /identity/);
  assert.equal(f.calls.length, 2);
});
test("factory label changes use targeted additions/removals rather than replacing the label set", async () => {
  const f = fixture(() => Response.json([]));
  await f.api.addLabels(9, ["agent-review"]); await f.api.removeLabel(9, "agent-waiting");
  assert.equal(f.calls[0].method, "POST"); assert.deepEqual(f.calls[0].body, { labels: ["agent-review"] });
  assert.equal(f.calls[1].method, "DELETE"); assert.ok(f.calls[1].url.endsWith("/issues/9/labels/agent-waiting"));
  assert.equal(f.api.setLabels, undefined);
});
test("accepted Actions cancellation and rerun responses need no JSON body", async () => {
  const f = fixture(() => new Response(null, { status: 202 }));
  await f.api.cancelRun("100"); await f.api.rerunFailedJobs("101");
  assert.equal(f.calls.length, 2);
});
test("ready-for-review uses a fixed mutation with a bound node ID and treats partial GraphQL responses as uncertain", async () => {
  const f = fixture(() => Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { number: 9, headRefOid: "a".repeat(40), isDraft: false } } } }));
  assert.equal((await f.api.ready("PR_9")).isDraft, false);
  assert.equal(f.calls[0].url, "https://api.github.com/graphql");
  assert.deepEqual(f.calls[0].body.variables, { id: "PR_9" });
  assert.ok(!f.calls[0].body.query.includes("mergePullRequest"));
  const partial = fixture(() => Response.json({ errors: [{ message: "interrupted" }], data: null }));
  await assert.rejects(() => partial.api.ready("PR_9"), /uncertain/);
});

test("thread writes use fixed GraphQL operations with bound IDs and preserve unknown partial outcomes", async () => {
  const f = fixture((_url, init) => {
    const { query } = JSON.parse(init.body);
    return query.includes("addPullRequestReviewThreadReply") ? Response.json({ data: { addPullRequestReviewThreadReply: { comment: {
      id: "RC1", body: "Fixed", author: { login: "ntodd-agent", __typename: "Bot" }, pullRequest: { number: 9 },
    } } } }) : Response.json({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true, pullRequest: { number: 9 } } } } });
  });
  assert.equal((await f.api.replyThread("T1", "Fixed", "op/reply")).author, "ntodd-agent[bot]");
  assert.equal((await f.api.resolveThread("T1", "op/resolve")).isResolved, true);
  assert.deepEqual(f.calls[0].body.variables, { thread: "T1", body: "Fixed", mutation: "op/reply" });
  assert.deepEqual(f.calls[1].body.variables, { thread: "T1", mutation: "op/resolve" });
  const partial = fixture(() => Response.json({ errors: [{ message: "interrupted" }], data: { resolveReviewThread: null } }));
  await assert.rejects(() => partial.api.resolveThread("T1", "op/resolve"), /uncertain/);
});
