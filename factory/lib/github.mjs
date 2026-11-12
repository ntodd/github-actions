// Read authoritative GitHub facts without a project checkout. Pagination is
// complete or the read fails; a partial conversation is never treated as all
// of a user's instructions. No mutation methods live on this client.
import { GitHubError } from "./store.mjs";
import { LIVE_RUN_STATUSES } from "./runtime-guard.mjs";
const login = (a) => a ? `${a.login}${a.__typename === "Bot" && !a.login.endsWith("[bot]") ? "[bot]" : ""}` : "ghost";
const sha = (v) => /^[0-9a-f]{40}$/.test(v);
const positive = (v) => typeof v === "string" && /^[1-9]\d{0,39}$/.test(v) || Number.isSafeInteger(v) && v > 0;
export function readClient({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  const [owner, name] = repo.split("/");
  const origin = new URL(apiUrl).origin, root = `${apiUrl}/repos/${repo}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory" };
  async function request(url, method = "GET", body) {
    if (new URL(url).origin !== origin) throw new Error("Refusing to send GitHub credentials to another origin");
    const res = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(20_000), headers: body ? { ...headers, "content-type": "application/json" } : headers,
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new GitHubError(res.status, method, new URL(url).pathname);
    return { res, data: await res.json() };
  }
  async function list(path, pick = (data) => data, limit = 1000000) {
    let next = `${root}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    const seen = new Set(), all = [];
    while (next) {
      if (seen.has(next) || seen.size >= 10000 || !new URL(next).href.startsWith(`${root}/`)) throw new Error("Invalid or excessive GitHub pagination");
      seen.add(next);
      const { res, data } = await request(next), values = pick(data);
      if (!Array.isArray(values)) throw new Error("Malformed GitHub list response");
      all.push(...values);
      if (all.length > limit) throw new Error("GitHub listing exceeded its item limit");
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return all;
  }
  async function stepLog(job, step, maxBytes = 512 * 1024) {
    if (!positive(job) || !Number.isSafeInteger(step) || step < 1 || step > 10000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("Invalid diagnostic log request");
    const path = `/actions/jobs/${job}/steps/${step}/logs`;
    let response = await fetch(`${root}${path}`, { headers: { ...headers, "x-github-api-version": "2026-03-10" },
      redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (response.status === 302) {
      const location = new URL(response.headers.get("location"));
      await response.body?.cancel();
      if (location.protocol !== "https:" || location.username || location.password) throw new Error("Invalid diagnostic log download");
      // The authenticated GitHub endpoint supplies the signed URL. No token,
      // App credential or project configuration follows it to blob storage.
      response = await fetch(location.href, { redirect: "error", signal: AbortSignal.timeout(20000) });
    }
    if (!response.ok) { await response.body?.cancel(); throw new GitHubError(response.status, "GET", path); }
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) { await response.body?.cancel(); throw new Error("Diagnostic log exceeded its size limit"); }
    if (!response.body) throw new Error("Diagnostic log has no body");
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("Diagnostic log exceeded its size limit");
        chunks.push(chunk);
      }
    } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function graphql(query, variables) {
    const url = apiUrl.endsWith("/api/v3") ? `${origin}/api/graphql` : `${apiUrl}/graphql`;
    const { data } = await request(url, "POST", { query, variables: { owner, name, ...variables } });
    if (data.errors?.length || !data.data) throw new Error("Could not read complete GitHub GraphQL facts");
    return data.data;
  }
  async function pages(query, variables, pick) {
    let cursor = null;
    const seen = new Set(), all = [];
    do {
      const connection = pick(await graphql(query, { ...variables, cursor }));
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error("Missing GitHub connection");
      all.push(...connection.nodes);
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      if (connection.pageInfo.hasNextPage && (!cursor || seen.has(cursor) || seen.size >= 10000)) throw new Error("Incomplete GraphQL pagination");
      seen.add(cursor);
    } while (cursor);
    return all;
  }
  const textFields = "id fullDatabaseId body createdAt updatedAt lastEditedAt author { __typename login }";
  const databaseId = (fact) => {
    const raw = fact.fullDatabaseId ?? fact.databaseId, numeric = Number(raw);
    return Number.isSafeInteger(numeric) ? numeric : raw;
  };
  async function withEdits(fact, kind) {
    // Only GraphQL's edit metadata can establish that text was never edited;
    // equal second-precision REST timestamps cannot establish it.
    if (Object.hasOwn(fact, "lastEditedAt") && fact.lastEditedAt === null) return fact;
    const nodeId = fact.node_id ?? fact.id;
    if (typeof nodeId !== "string") throw new Error("Edited content lacks an identity for edit-history validation");
    let lastEditedAt;
    const edits = await pages(`query($id:ID!,$cursor:String){node(id:$id){... on ${kind}{lastEditedAt userContentEdits(first:100,after:$cursor){nodes{editor{__typename login}}pageInfo{hasNextPage endCursor}}}}}`,
      { id: nodeId }, (d) => { lastEditedAt = d.node?.lastEditedAt; return d.node?.userContentEdits; });
    if (lastEditedAt !== null && (typeof lastEditedAt !== "string" || !Number.isFinite(Date.parse(lastEditedAt)))) throw new Error("Content lacks authoritative edit metadata");
    return { ...fact, lastEditedAt, editors: edits.map((edit) => login(edit.editor)) };
  }
  return {
    apiUrl,
    repository: async () => (await request(root)).data,
    workflows: () => list("/actions/workflows", (data) => data.workflows, 1000),
    liveWorkflowRuns: async (id) => {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid workflow identity");
      const results = await Promise.all(LIVE_RUN_STATUSES.map(async (status) => {
        const { data } = await request(`${root}/actions/workflows/${id}/runs?status=${status}&per_page=1`);
        if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs)
          || data.total_count === 0 && data.workflow_runs.length !== 0 || data.total_count > 0 && !data.workflow_runs.length) {
          throw new Error("Incomplete live workflow-run count");
        }
        // Only a zero authoritative filtered count proves absence. Nonzero
        // counts block execution; no history scan or unbounded pagination.
        return data.total_count ? data.workflow_runs.slice(0, 1) : [];
      }));
      return results.flat();
    },
    branchSha: async (branch) => (await request(`${root}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)).data.object.sha,
    fileAt: async (path, commit) => {
      if (!sha(commit)) throw new Error("Config reads must be pinned to a commit");
      const { data } = await request(`${root}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`);
      if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string" || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > 128 * 1024 || data.content.length > 200 * 1024) throw new Error("Invalid repository config file");
      const content = Buffer.from(data.content, "base64");
      if (content.length !== data.size) throw new Error("Config content size does not match GitHub metadata");
      return { sha: data.sha, content: content.toString("utf8") };
    },
    run: async (id, attempt = null) => (await request(`${root}/actions/runs/${encodeURIComponent(id)}${attempt === null ? "" : `/attempts/${Number(attempt)}`}`)).data,
    job: async (id) => {
      if (!positive(id)) throw new Error("A stable job ID is required");
      return (await request(`${root}/actions/jobs/${id}`)).data;
    },
    annotations: (id) => {
      if (!positive(id)) throw new Error("A stable check ID is required");
      return list(`/check-runs/${id}/annotations`, (data) => data, 1000);
    },
    stepLog,
    issue: async (number) => (await request(`${root}/issues/${Number(number)}`)).data,
    pull: async (number) => (await request(`${root}/pulls/${Number(number)}`)).data,
    openIssues: async () => (await list("/issues?state=open")).filter((i) => !i.pull_request),
    openPulls: () => list("/pulls?state=open"),
    branchRules: (branch) => list(`/rules/branches/${encodeURIComponent(branch)}`),
    commit: async (commit) => {
      if (!sha(commit)) throw new Error("A commit SHA is required");
      return (await request(`${root}/git/commits/${commit}`)).data;
    },
    compare: async (base, head) => {
      if (![base, head].every(sha)) throw new Error("Comparison must use recorded commits");
      return (await request(`${root}/compare/${base}...${head}`)).data;
    },
    checks: async (commit) => {
      if (!sha(commit)) throw new Error("Checks must use an exact commit");
      const [checkRuns, statuses] = await Promise.all([
        list(`/commits/${commit}/check-runs?filter=latest`, (d) => d.check_runs), list(`/commits/${commit}/statuses`),
      ]);
      return { sha: commit, checkRuns, statuses };
    },
    pullStatus: async (number) => (await graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid mergeable reviewDecision autoMergeRequest{enabledAt}}}}`, { number })).repository?.pullRequest,
    events: (number) => list(`/issues/${Number(number)}/events`),
    comments: async (number) => Promise.all((await list(`/issues/${Number(number)}/comments`)).map((c) => withEdits(c, "IssueComment"))),
    labeledIssues: async (label) => (await list(`/issues?state=open&labels=${encodeURIComponent(label)}`)).filter((i) => !i.pull_request),
    editors: async (number, kind = "issue") => {
      if (!["issue", "pullRequest"].includes(kind)) throw new Error("Invalid edit-history subject");
      const prefix = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){${kind}(number:$number){`;
      const edits = await pages(`${prefix}userContentEdits(first:100,after:$cursor){nodes{editor{__typename login}}pageInfo{hasNextPage endCursor}}}}}`,
        { number }, (d) => d.repository?.[kind]?.userContentEdits);
      const renames = await pages(`${prefix}timelineItems(first:100,after:$cursor,itemTypes:[RENAMED_TITLE_EVENT]){nodes{... on RenamedTitleEvent{actor{__typename login}}}pageInfo{hasNextPage endCursor}}}}}`,
        { number }, (d) => d.repository?.[kind]?.timelineItems);
      return [...edits.map((e) => login(e.editor)), ...renames.map((e) => login(e.actor))];
    },
    reviews: async (number) => {
      const reviews = await pages(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(first:100,after:$cursor){nodes{${textFields} state commit{oid}}pageInfo{hasNextPage endCursor}}}}}`,
        { number }, (d) => d.repository?.pullRequest?.reviews);
      return Promise.all(reviews.map(async (review) => {
        const r = await withEdits(review, "PullRequestReview");
        return { ...r, nodeId: r.id, id: databaseId(r), author: login(r.author), commitSha: r.commit?.oid };
      }));
    },
    threads: async (number) => {
      const threads = await pages(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50,after:$cursor){nodes{id isResolved isOutdated path line}pageInfo{hasNextPage endCursor}}}}}`,
        { number }, (d) => d.repository?.pullRequest?.reviewThreads);
      const all = [];
      for (const thread of threads) {
        const comments = await pages(`query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{${textFields} url}pageInfo{hasNextPage endCursor}}}}}`,
          { id: thread.id }, (d) => d.node?.comments);
        all.push({ ...thread, comments: await Promise.all(comments.map(async (comment) => { const c = await withEdits(comment, "PullRequestReviewComment"); return { ...c, nodeId: c.id, id: databaseId(c), author: login(c.author) }; })) });
      }
      return all;
    },
  };
}
