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

const node = (over = {}) => ({
  number: 9,
  id: "PR_9",
  state: "OPEN",
  isDraft: false,
  title: "Fix it",
  body: "Fixes #7",
  createdAt: "2026-11-07T13:00:00Z",
  updatedAt: "2026-11-08T09:00:00Z",
  mergeable: "CONFLICTING",
  headRefOid: "abc",
  headRefName: "feature/7-fix",
  baseRefName: "main",
  headRepository: { nameWithOwner: "ntodd/sandbox" },
  baseRepository: { defaultBranchRef: { name: "main" } },
  author: { __typename: "Bot", login: "ntodd-agent" },
  labels: { nodes: [{ name: "agent-conflict" }] },
  userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [{ editor: { __typename: "Bot", login: "ntodd-agent" } }] },
  timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ actor: { __typename: "User", login: "ntodd" } }] },
  closingIssuesReferences: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ number: 7, repository: { nameWithOwner: "ntodd/sandbox" } }] },
  ...over,
});

test("pull reads what a resolve run checks: mergeable, author as a REST login, head, base and what it closes", async () => {
  const { gh: c, calls } = gh([["POST /graphql", () => Response.json({ data: { repository: { pullRequest: node() } } })]]);
  assert.deepEqual(await c.pull(9), {
    number: 9,
    nodeId: "PR_9",
    state: "open",
    draft: false,
    title: "Fix it",
    body: "Fixes #7",
    author: "ntodd-agent[bot]",
    createdAt: "2026-11-07T13:00:00Z",
    updatedAt: "2026-11-08T09:00:00Z",
    mergeable: "CONFLICTING",
    headSha: "abc",
    headRef: "feature/7-fix",
    headRepo: "ntodd/sandbox",
    baseRef: "main",
    defaultBranch: "main",
    labels: ["agent-conflict"],
    editors: ["ntodd-agent[bot]", "ntodd"],
    closes: { total: 1, more: false, issues: [{ number: 7, repo: "ntodd/sandbox" }] },
  });
  assert.deepEqual(calls[0].body.variables, { owner: "ntodd", name: "sandbox", number: 9 });
  assert.match(calls[0].body.query, /closingIssuesReferences/);
});

test("pull copes with a deleted fork and a deleted author, and is null for a PR that isn't there", async () => {
  const { gh: c } = gh([["POST /graphql", () => Response.json({ data: { repository: { pullRequest: node({ headRepository: null, author: null, state: "MERGED" }) } } })]]);
  const p = await c.pull(9);
  assert.equal(p.headRepo, "");
  assert.equal(p.author, "ghost");
  assert.equal(p.state, "merged");
  const missing = gh([["POST /graphql", () => Response.json({ data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 99." }] })]]);
  assert.equal(await missing.gh.pull(99), null);
});

test("openPulls pages through every open PR", async () => {
  let page = 0;
  const { gh: c, calls } = gh([
    [
      "POST /graphql",
      () =>
        Response.json({
          data: { repository: { pullRequests: page++ === 0 ? { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node()] } : { pageInfo: { hasNextPage: false }, nodes: [node({ number: 10 })] } } },
        }),
    ],
  ]);
  assert.deepEqual((await c.openPulls()).map((p) => p.number), [9, 10]);
  assert.equal(calls[1].body.variables.cursor, "c1");
});

test("labelEvents lists who added each label and when, commentById reads one comment, and branchSha a branch's tip", async () => {
  const { gh: c, calls } = gh([
    [
      "GET /issues/7/events",
      () =>
        Response.json([
          { event: "labeled", label: { name: "agent-ready" }, actor: { login: "ntodd" }, created_at: "2026-11-07T12:00:00Z" },
          { event: "unlabeled", label: { name: "agent-ready" }, actor: { login: "ntodd-agent[bot]" }, created_at: "2026-11-07T12:01:00Z" },
          { event: "labeled", label: { name: "agent-working" }, actor: null, created_at: "2026-11-07T12:01:01Z" },
        ]),
    ],
    ["GET /issues/comments/41", () => Response.json({ id: 41, body: "/resolve", user: { login: "ntodd" }, issue_url: "https://api.github.com/repos/ntodd/sandbox/issues/12" })],
    ["GET /git/ref/heads/release/1.x", () => Response.json({ object: { sha: "def" } })],
  ]);
  assert.deepEqual(await c.labelEvents(7), [
    { label: "agent-ready", actor: "ntodd", at: "2026-11-07T12:00:00Z" },
    { label: "agent-working", actor: "ghost", at: "2026-11-07T12:01:01Z" },
  ]);
  assert.deepEqual(await c.commentById(41), { id: 41, pr: 12, body: "/resolve", author: "ntodd" });
  assert.equal(await c.commentById(42), null);
  assert.equal(await c.branchSha("release/1.x"), "def");
  assert.equal(new URL(calls.at(-1).url).pathname, "/repos/ntodd/sandbox/git/ref/heads/release/1.x");
});

test("pull counts edits past the first page as someone untrusted", async () => {
  const { gh: c } = gh([["POST /graphql", () => Response.json({ data: { repository: { pullRequest: node({ userContentEdits: { pageInfo: { hasNextPage: true }, nodes: [] } }) } } })]]);
  assert.deepEqual((await c.pull(9)).editors, ["(more than 100 edits)"]);
});

test("activeResolves reads the PRs of dispatched resolve runs that haven't finished", async () => {
  const { gh: c, calls } = gh([
    [
      "GET /actions/workflows/agent-ready.yml/runs",
      () =>
        Response.json({
          workflow_runs: [
            { status: "queued", display_title: "agent-ready: resolve #9" },
            { status: "in_progress", display_title: "agent-ready: resolve #12" },
            { status: "completed", display_title: "agent-ready: resolve #13" },
            { status: "in_progress", display_title: "agent-ready" },
          ],
        }),
    ],
  ]);
  assert.deepEqual(await c.activeResolves("agent-ready.yml"), [9, 12]);
  assert.match(calls[0].url, /event=workflow_dispatch/);
});

test("dispatch starts a workflow on a ref with string inputs", async () => {
  const { gh: c, calls } = gh([["POST /actions/workflows/agent-ready.yml/dispatches", () => new Response(null, { status: 204 })]]);
  await c.dispatch("agent-ready.yml", "main", { issue: "7", mode: "resolve", pr: "9", head: "abc" });
  assert.deepEqual(calls[0].body, { ref: "main", inputs: { issue: "7", mode: "resolve", pr: "9", head: "abc" } });
});

test("labeledIssues lists the open issues with a label, without pull requests", async () => {
  const { gh: c, calls } = gh([["GET /issues?", () => Response.json([{ number: 7 }, { number: 8, pull_request: {} }])]]);
  assert.deepEqual((await c.labeledIssues("agent-working")).map((i) => i.number), [7]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("labels"), "agent-working");
  assert.equal(url.searchParams.get("state"), "open");
});
