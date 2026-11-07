// The GitHub calls the run makes, over fetch. One client per token: the
// job's read-only GITHUB_TOKEN for watching, an App token for writes.

export function client({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  const [owner, name] = repo.split("/");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "agent-ready",
  };

  async function call(method, path, body, { ok = [] } = {}) {
    const url = path.startsWith("http") ? path : `${apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (ok.includes(res.status)) return { res, data: null };
    if (!res.ok) throw new Error(`${method} ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    // Some writes (a job rerun, say) answer 201 with no body.
    const text = res.status === 204 ? "" : await res.text();
    return { res, data: text ? JSON.parse(text) : null };
  }

  async function list(path, pick = (d) => d) {
    const out = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const { res, data } = await call("GET", next);
      out.push(...pick(data));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return out;
  }

  async function graphql(query, variables) {
    const { data } = await call("POST", "/graphql", { query, variables });
    if (data.errors?.length) throw new Error(`GraphQL: ${data.errors.map((e) => e.message).join("; ")}`);
    return data.data;
  }

  const r = `/repos/${owner}/${name}`;
  return {
    issue: async (n) => (await call("GET", `${r}/issues/${n}`)).data,
    user: async (login) => (await call("GET", `/users/${encodeURIComponent(login)}`)).data,
    comments: (n) => list(`${r}/issues/${n}/comments`),
    subIssues: async (n) => {
      try {
        return (await list(`${r}/issues/${n}/sub_issues`)).map((i) => ({ number: i.number, title: i.title, state: i.state }));
      } catch (err) {
        if (/: 404 /.test(err.message)) return [];
        throw err;
      }
    },
    pr: async (n) => {
      const { data: p } = await call("GET", `${r}/pulls/${n}`);
      return { number: p.number, state: p.merged ? "merged" : p.state, draft: p.draft, headSha: p.head.sha, nodeId: p.node_id };
    },
    prBody: async (n) => ({ body: (await call("GET", `${r}/pulls/${n}`)).data.body ?? "" }),
    setPrBody: async (n, body) => void (await call("PATCH", `${r}/pulls/${n}`, { body })),
    // Each check run gets the workflow it came from, so summarizeChecks can
    // tell a rerun of the same workflow from another workflow's job.
    checks: async (sha) => {
      const checkRuns = await list(`${r}/commits/${sha}/check-runs?filter=latest`, (d) => d.check_runs);
      const statuses = (await call("GET", `${r}/commits/${sha}/status`)).data.statuses ?? [];
      let runs = [];
      try {
        runs = await list(`${r}/actions/runs?head_sha=${sha}`, (d) => d.workflow_runs);
      } catch {
        // Without actions: read, same-named jobs are only told apart by suite.
      }
      const workflowOf = new Map(runs.map((w) => [w.check_suite_id, w.workflow_id]));
      return { checkRuns: checkRuns.map((c) => ({ ...c, workflow: workflowOf.get(c.check_suite?.id) })), statuses };
    },
    activity: async (n) => ({ reviews: await list(`${r}/pulls/${n}/reviews`), comments: await list(`${r}/issues/${n}/comments`) }),
    threads: async (n) => {
      const data = await graphql(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes { id isResolved isOutdated path line comments(first: 1) { nodes { author { login } body url } } }
              }
            }
          }
        }`,
        { owner, name, number: n },
      );
      return data.repository.pullRequest.reviewThreads.nodes;
    },
    removeLabel: async (n, label) => void (await call("DELETE", `${r}/issues/${n}/labels/${encodeURIComponent(label)}`, undefined, { ok: [404] })),
    addLabels: async (n, labels) => void (await call("POST", `${r}/issues/${n}/labels`, { labels })),
    comment: async (n, body) => (await call("POST", `${r}/issues/${n}/comments`, { body })).data?.id,
    getComment: async (id) => (await call("GET", `${r}/issues/comments/${id}`)).data.body ?? "",
    editComment: async (id, body) => void (await call("PATCH", `${r}/issues/comments/${id}`, { body })),
    // Logins, or org/team for a team.
    requestReviewers: async (n, who) =>
      void (await call("POST", `${r}/pulls/${n}/requested_reviewers`, {
        reviewers: who.filter((w) => !w.includes("/")),
        team_reviewers: who.filter((w) => w.includes("/")).map((w) => w.split("/")[1]),
      })),
    rerunJob: async (id) => void (await call("POST", `${r}/actions/jobs/${id}/rerun`)),
    markReady: async (nodeId) =>
      void (await graphql(`mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`, { id: nodeId })),
  };
}
