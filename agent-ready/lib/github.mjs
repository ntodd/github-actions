// The GitHub calls the run makes, over fetch. One client per token: the
// job's read-only GITHUB_TOKEN for watching, an App token for writes.

// A GraphQL actor as its REST login: a bot's gets "[bot]" back, and a
// deleted account is "ghost".
const restLogin = (a) => (!a ? "ghost" : a.__typename === "Bot" ? `${a.login}[bot]` : a.login);

// What a resolve run, the sweep and the /resolve job read about a PR.
const PULL = `
  number id state isDraft title body createdAt updatedAt mergeable
  headRefOid headRefName baseRefName
  headRepository { nameWithOwner }
  baseRepository { defaultBranchRef { name } }
  author { __typename login }
  labels(first: 50) { nodes { name } }
  userContentEdits(first: 100) { pageInfo { hasNextPage } nodes { editor { __typename login } } }
  timelineItems(first: 100, itemTypes: [RENAMED_TITLE_EVENT]) { pageInfo { hasNextPage } nodes { ... on RenamedTitleEvent { actor { __typename login } } } }
  closingIssuesReferences(first: 10) { totalCount pageInfo { hasNextPage } nodes { number repository { nameWithOwner } } }`;

const pull = (p) => ({
  number: p.number,
  nodeId: p.id,
  state: p.state.toLowerCase(),
  draft: p.isDraft,
  title: p.title,
  body: p.body ?? "",
  author: restLogin(p.author),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  mergeable: p.mergeable,
  headSha: p.headRefOid,
  headRef: p.headRefName,
  // A fork that's been deleted has no head repository.
  headRepo: p.headRepository?.nameWithOwner ?? "",
  baseRef: p.baseRefName,
  defaultBranch: p.baseRepository?.defaultBranchRef?.name ?? "",
  labels: p.labels.nodes.map((l) => l.name),
  // Everyone who edited the description or the title, as for an issue.
  editors:
    p.userContentEdits.pageInfo.hasNextPage || p.timelineItems.pageInfo.hasNextPage
      ? ["(more than 100 edits)"]
      : [...p.userContentEdits.nodes.map((e) => restLogin(e.editor)), ...p.timelineItems.nodes.map((e) => restLogin(e.actor))],
  closes: {
    total: p.closingIssuesReferences.totalCount,
    more: p.closingIssuesReferences.pageInfo.hasNextPage,
    issues: p.closingIssuesReferences.nodes.map((i) => ({ number: i.number, repo: i.repository.nameWithOwner })),
  },
});

export function client({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
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
    // Everyone who edited the body or changed the title, as REST logins
    // (GraphQL drops a bot's "[bot]"). A deleted account is "ghost", and
    // edits past the first 100 count as someone unknown.
    editors: async (n) => {
      const d = await graphql(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              userContentEdits(first: 100) { pageInfo { hasNextPage } nodes { editor { __typename login } } }
              timelineItems(first: 100, itemTypes: [RENAMED_TITLE_EVENT]) { pageInfo { hasNextPage } nodes { ... on RenamedTitleEvent { actor { __typename login } } } }
            }
          }
        }`,
        { owner, name, number: n },
      );
      const { userContentEdits: edits, timelineItems: renames } = d.repository.issue;
      if (edits.pageInfo.hasNextPage || renames.pageInfo.hasNextPage) return ["(more than 100 edits)"];
      return [...edits.nodes.map((e) => restLogin(e.editor)), ...renames.nodes.map((e) => restLogin(e.actor))];
    },
    user: async (login) => (await call("GET", `/users/${encodeURIComponent(login)}`)).data,
    comments: (n) => list(`${r}/issues/${n}/comments`),
    subIssues: async (n) => {
      try {
        return (await list(`${r}/issues/${n}/sub_issues`)).map((i) => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login }));
      } catch (err) {
        if (/: 404 /.test(err.message)) return [];
        throw err;
      }
    },
    pr: async (n) => {
      const { data: p } = await call("GET", `${r}/pulls/${n}`);
      return { number: p.number, state: p.merged ? "merged" : p.state, draft: p.draft, headSha: p.head.sha, nodeId: p.node_id };
    },
    // One PR with its mergeable state, or null when there's no such PR.
    // GitHub works mergeable out in the background, so it can be UNKNOWN.
    pull: async (n) => {
      const { data } = await call("POST", "/graphql", {
        query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {${PULL} } } }`,
        variables: { owner, name, number: n },
      });
      const found = data.data?.repository?.pullRequest;
      if (found) return pull(found);
      if (data.errors?.every((e) => e.type === "NOT_FOUND")) return null;
      throw new Error(`GraphQL: ${(data.errors ?? [{ message: "no pull request in the answer" }]).map((e) => e.message).join("; ")}`);
    },
    // Every open PR, least recently updated first.
    openPulls: async () => {
      const out = [];
      let cursor = null;
      do {
        const d = await graphql(
          `query($owner: String!, $name: String!, $cursor: String) {
            repository(owner: $owner, name: $name) {
              pullRequests(states: OPEN, first: 30, after: $cursor, orderBy: { field: UPDATED_AT, direction: ASC }) { pageInfo { hasNextPage endCursor } nodes {${PULL} } }
            }
          }`,
          { owner, name, cursor },
        );
        const page = d.repository.pullRequests;
        out.push(...page.nodes.map(pull));
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (cursor);
      return out;
    },
    // Who added each label and when, oldest first. This is GitHub's record
    // of who labeled an issue, which outlives the label.
    labelEvents: async (n) =>
      (await list(`${r}/issues/${n}/events`)).filter((e) => e.event === "labeled").map((e) => ({ label: e.label?.name, actor: e.actor?.login ?? "ghost", at: e.created_at })),
    commentById: async (id) => {
      const { data: c } = await call("GET", `${r}/issues/comments/${id}`, undefined, { ok: [404] });
      return c && { id: c.id, pr: Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? "")?.[1]), body: c.body ?? "", author: c.user?.login };
    },
    branchSha: async (branch) => (await call("GET", `${r}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)).data.object.sha,
    // The PRs with a resolve run that's queued or going, read from the
    // names the caller gives its dispatched runs ("... resolve #9"). A run
    // labels its issue agent-working only once it's on a runner, and this
    // covers the wait before that.
    activeResolves: async (workflow) => {
      const { data } = await call("GET", `${r}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100`);
      return (data.workflow_runs ?? [])
        .filter((w) => w.status !== "completed")
        .map((w) => Number(/resolve #(\d+)/.exec(w.display_title ?? "")?.[1]))
        .filter(Boolean);
    },
    // inputs are strings. From the job's GITHUB_TOKEN this does start a
    // workflow, unlike most events that token causes.
    // GitHub now and then answers a dispatch with a 500 ("Failed to run
    // workflow dispatch"), so a 5xx gets two more tries.
    dispatch: async (workflow, ref, inputs) => {
      for (const wait of [2000, 5000, null]) {
        try {
          return void (await call("POST", `${r}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs }));
        } catch (err) {
          if (wait === null || !/: 5\d\d /.test(err.message)) throw err;
          await sleep(wait);
        }
      }
    },
    prBody: async (n) => ({ body: (await call("GET", `${r}/pulls/${n}`)).data.body ?? "" }),
    setPrBody: async (n, body) => void (await call("PATCH", `${r}/pulls/${n}`, { body })),
    // Each check run gets the workflow, event and branch it ran for, so
    // summarizeChecks collapses only true duplicates.
    checks: async (sha) => {
      const checkRuns = await list(`${r}/commits/${sha}/check-runs?filter=latest`, (d) => d.check_runs);
      const statuses = (await call("GET", `${r}/commits/${sha}/status`)).data.statuses ?? [];
      let runs = [];
      try {
        runs = await list(`${r}/actions/runs?head_sha=${sha}`, (d) => d.workflow_runs);
      } catch {
        // Without actions: read, same-named jobs are only told apart by suite.
      }
      const workflowOf = new Map(runs.map((w) => [w.check_suite_id, `${w.workflow_id} ${w.event} ${w.head_branch}`]));
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
    rerunFailedJobs: async (run) => void (await call("POST", `${r}/actions/runs/${run}/rerun-failed-jobs`)),
    markReady: async (nodeId) =>
      void (await graphql(`mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`, { id: nodeId })),
  };
}
