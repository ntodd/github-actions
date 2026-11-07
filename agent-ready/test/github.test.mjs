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
