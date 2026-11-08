import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "../lib/github.mjs";

function fake(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    for (const [pattern, handler] of routes) {
      const [m, p] = pattern.split(" ");
      if (m === method && url.includes(p)) return handler(url, init);
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  return { fetch, calls };
}

const gh = (routes) => {
  const f = fake(routes);
  return { gh: client({ token: "tok", repo: "ntodd/sandbox", fetch: f.fetch }), calls: f.calls };
};

test("lists follow Link headers across pages", async () => {
  const { gh: c, calls } = gh([
    [
      "GET /issues/7/comments",
      (url) =>
        url.includes("page=2")
          ? Response.json([{ id: 2 }])
          : Response.json([{ id: 1 }], { headers: { link: '<https://api.github.com/repos/ntodd/sandbox/issues/7/comments?per_page=100&page=2>; rel="next"' } }),
    ],
  ]);
  assert.deepEqual((await c.comments(7)).map((x) => x.id), [1, 2]);
  assert.equal(calls[0].auth, "Bearer tok");
});

test("pr reports merged PRs as merged and gives the head commit and node id", async () => {
  const { gh: c } = gh([["GET /pulls/5", () => Response.json({ number: 5, state: "closed", merged: true, draft: false, head: { sha: "abc" }, node_id: "PR_x" })]]);
  assert.deepEqual(await c.pr(5), { number: 5, state: "merged", draft: false, headSha: "abc", nodeId: "PR_x" });
});

test("checks reads the latest check runs and the combined status", async () => {
  const { gh: c, calls } = gh([
    ["GET /commits/abc/check-runs", () => Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] })],
    ["GET /commits/abc/status", () => Response.json({ state: "success", statuses: [{ context: "ci", state: "success" }] })],
  ]);
  const res = await c.checks("abc");
  assert.equal(res.checkRuns[0].name, "test");
  assert.equal(res.statuses[0].context, "ci");
  assert.match(calls[0].url, /filter=latest/);
});

test("checks keys each check run by workflow, event and branch, so only true duplicates collapse", async () => {
  const { gh: c } = gh([
    [
      "GET /commits/abc/check-runs",
      () => Response.json({ check_runs: [100, 200, 300, 400, 500].map((id) => ({ name: "test", check_suite: { id } })) }),
    ],
    ["GET /commits/abc/status", () => Response.json({ statuses: [] })],
    [
      "GET /actions/runs",
      () =>
        Response.json({
          workflow_runs: [
            { check_suite_id: 100, workflow_id: 1, event: "pull_request", head_branch: "a" },
            { check_suite_id: 200, workflow_id: 1, event: "pull_request", head_branch: "a" },
            { check_suite_id: 300, workflow_id: 1, event: "push", head_branch: "a" },
            { check_suite_id: 400, workflow_id: 2, event: "pull_request", head_branch: "a" },
          ],
        }),
    ],
  ]);
  const res = await c.checks("abc");
  assert.deepEqual(res.checkRuns.map((r) => r.workflow), ["1 pull_request a", "1 pull_request a", "1 push a", "2 pull_request a", undefined]);
});

test("checks still works when the workflow runs can't be read", async () => {
  const { gh: c } = gh([
    ["GET /commits/abc/check-runs", () => Response.json({ check_runs: [{ name: "test", check_suite: { id: 100 } }] })],
    ["GET /commits/abc/status", () => Response.json({ statuses: [] })],
  ]);
  assert.equal((await c.checks("abc")).checkRuns[0].workflow, undefined);
});

test("threads comes from GraphQL", async () => {
  const { gh: c, calls } = gh([
    [
      "POST /graphql",
      () => Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T1", isResolved: false }] } } } } }),
    ],
  ]);
  assert.deepEqual(await c.threads(5), [{ id: "T1", isResolved: false }]);
  assert.deepEqual(calls[0].body.variables, { owner: "ntodd", name: "sandbox", number: 5 });
});

test("editors lists who edited an issue's body or renamed it, as REST logins, with deleted accounts as ghost", async () => {
  const { gh: c, calls } = gh([
    [
      "POST /graphql",
      () =>
        Response.json({
          data: {
            repository: {
              issue: {
                userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [{ editor: { __typename: "Bot", login: "github-actions" } }, { editor: null }] },
                timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ actor: { __typename: "User", login: "ntodd" } }, { actor: { __typename: "Bot", login: "ntodd-agent" } }] },
              },
            },
          },
        }),
    ],
  ]);
  assert.deepEqual(await c.editors(7), ["github-actions[bot]", "ghost", "ntodd", "ntodd-agent[bot]"]);
  assert.deepEqual(calls[0].body.variables, { owner: "ntodd", name: "sandbox", number: 7 });
});

test("editors past the first page count as someone untrusted", async () => {
  const page = { pageInfo: { hasNextPage: true }, nodes: [] };
  const { gh: c } = gh([["POST /graphql", () => Response.json({ data: { repository: { issue: { userContentEdits: page, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } })]]);
  assert.deepEqual(await c.editors(7), ["(more than 100 edits)"]);
});

test("sub-issues carry their author", async () => {
  const { gh: c } = gh([["GET /issues/7/sub_issues", () => Response.json([{ number: 8, title: "A", state: "open", user: { login: "ntodd" } }])]]);
  assert.deepEqual(await c.subIssues(7), [{ number: 8, title: "A", state: "open", user: "ntodd" }]);
});

test("removeLabel tolerates a label that isn't there, and sub-issues are empty without the API", async () => {
  const { gh: c } = gh([]);
  await c.removeLabel(7, "agent-ready");
  assert.deepEqual(await c.subIssues(7), []);
});

test("writes go to the right endpoints", async () => {
  const { gh: c, calls } = gh([
    ["POST /issues/7/labels", () => Response.json([])],
    ["POST /issues/7/comments", () => Response.json({ id: 1 }, { status: 201 })],
    ["POST /graphql", () => Response.json({ data: {} })],
  ]);
  await c.addLabels(7, ["agent-working"]);
  await c.comment(7, "hi");
  await c.markReady("PR_x");
  assert.deepEqual(calls.map((x) => [x.method, new URL(x.url).pathname]), [
    ["POST", "/repos/ntodd/sandbox/issues/7/labels"],
    ["POST", "/repos/ntodd/sandbox/issues/7/comments"],
    ["POST", "/graphql"],
  ]);
  assert.deepEqual(calls[0].body, { labels: ["agent-working"] });
  assert.match(calls[2].body.query, /markPullRequestReadyForReview/);
});

test("comment returns the new comment's ID, and comments can be read and edited", async () => {
  const { gh: c, calls } = gh([
    ["POST /issues/7/comments", () => Response.json({ id: 41 }, { status: 201 })],
    ["PATCH /issues/comments/41", () => Response.json({ id: 41 })],
    ["GET /issues/comments/41", () => Response.json({ id: 41, body: "old" })],
  ]);
  assert.equal(await c.comment(7, "hi"), 41);
  await c.editComment(41, "new");
  assert.equal(await c.getComment(41), "old");
  assert.deepEqual(calls[1].body, { body: "new" });
});

test("requestReviewers splits users from org/team slugs, and rerunFailedJobs reruns a run's failed jobs", async () => {
  const { gh: c, calls } = gh([
    ["POST /pulls/5/requested_reviewers", () => Response.json({}, { status: 201 })],
    ["POST /actions/runs/11/rerun-failed-jobs", () => new Response(null, { status: 201 })],
  ]);
  await c.requestReviewers(5, ["ntodd", "acme/web"]);
  await c.rerunFailedJobs(11);
  assert.deepEqual(calls[0].body, { reviewers: ["ntodd"], team_reviewers: ["web"] });
  assert.equal(new URL(calls[1].url).pathname, "/repos/ntodd/sandbox/actions/runs/11/rerun-failed-jobs");
});

test("a failed request throws with the status and path", async () => {
  const { gh: c } = gh([["GET /pulls/9", () => new Response("boom", { status: 502 })]]);
  await assert.rejects(c.pr(9), /GET \/repos\/ntodd\/sandbox\/pulls\/9: 502 boom/);
});

test("prBody reads a PR's body and setPrBody replaces it", async () => {
  const { gh: c, calls } = gh([
    ["GET /pulls/5", () => Response.json({ number: 5, body: "hi" })],
    ["PATCH /pulls/5", () => Response.json({ number: 5 })],
  ]);
  assert.deepEqual(await c.prBody(5), { body: "hi" });
  await c.setPrBody(5, "new");
  assert.deepEqual(calls[1].body, { body: "new" });
});
