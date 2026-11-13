// Only clean controller/publisher jobs instantiate this API client. Mutations
// are single attempts; uncertainty is handled by the durable effect journal.
import { GitHubError } from "./store.mjs";
export function writeClient({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  const root = `${apiUrl}/repos/${repo}`, origin = new URL(apiUrl).origin;
  let canonicalRoot;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory" };
  async function call(method, path, body) {
    const url = path.startsWith("https://") ? path : `${root}${path}`;
    const target = new URL(url);
    if (target.origin !== origin) throw new Error("Unexpected GitHub API target");
    let sameRepository = target.href.startsWith(`${root}/`) || method === "GET" && target.href === root;
    if (!sameRepository && method === "GET" && target.href.startsWith(`${apiUrl}/repositories/`)) {
      if (canonicalRoot === undefined) {
        const { data } = await call("GET", "");
        if (Number.isSafeInteger(data.id) && data.id > 0 && data.full_name?.toLowerCase() === repo.toLowerCase()) {
          canonicalRoot = `${apiUrl}/repositories/${data.id}/`;
        }
      }
      sameRepository = canonicalRoot !== undefined && target.href.startsWith(canonicalRoot);
    }
    if (!sameRepository) throw new Error("Unexpected GitHub API target");
    const res = await fetch(url, { method, headers: body ? { ...headers, "content-type": "application/json" } : headers,
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new GitHubError(res.status, method, new URL(url).pathname);
    return { data: [202, 204].includes(res.status) ? null : await res.json(), link: res.headers.get("link") };
  }
  const commentPath = (kind, id) => {
    if (!Number.isSafeInteger(id) || id < 1 || !["issue-comment", "review-comment"].includes(kind)) throw new Error("Invalid comment identity");
    return kind === "issue-comment" ? `/issues/comments/${id}` : `/pulls/comments/${id}`;
  };
  async function ready(nodeId) {
    const url = apiUrl.endsWith("/api/v3") ? `${origin}/api/graphql` : `${apiUrl}/graphql`;
    const res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
      query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number headRefOid isDraft}}}", variables: { id: nodeId },
    }) });
    if (!res.ok) throw new GitHubError(res.status, "POST", "/graphql");
    const result = await res.json();
    if (result.errors?.length || !result.data?.markPullRequestReadyForReview?.pullRequest) throw new Error("Ready-for-review response is uncertain");
    return result.data.markPullRequestReadyForReview.pullRequest;
  }
  async function threadMutation(query, variables, field) {
    const url = apiUrl.endsWith("/api/v3") ? `${origin}/api/graphql` : `${apiUrl}/graphql`;
    const res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new GitHubError(res.status, "POST", "/graphql");
    const result = await res.json();
    if (result.errors?.length || !result.data?.[field]) throw new Error("Thread mutation response is uncertain");
    return result.data[field];
  }
  async function list(path) {
    let next = path;
    const seen = new Set(), all = [];
    while (next) {
      if (seen.has(next) || seen.size >= 10000) throw new Error("Invalid API pagination");
      seen.add(next);
      const { data, link } = await call("GET", next);
      if (!Array.isArray(data)) throw new Error("Invalid list from GitHub");
      all.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];
    }
    return all;
  }
  return {
    pullsForBranch: (head, base) => list(`/pulls?${new URLSearchParams({ state: "all", head: `${repo.split("/")[0]}:${head}`, base, per_page: "100" })}`),
    createPull: async (data) => (await call("POST", "/pulls", { ...data, draft: true, maintainer_can_modify: false })).data,
    comments: (number) => list(`/issues/${number}/comments?per_page=100`),
    comment: async (number, body) => (await call("POST", `/issues/${number}/comments`, { body })).data,
    editComment: async (id, body) => (await call("PATCH", `/issues/comments/${id}`, { body })).data,
    commentById: async (kind, id) => (await call("GET", commentPath(kind, id))).data,
    reactions: (kind, id) => list(`${commentPath(kind, id)}/reactions?per_page=100`),
    react: async (kind, id, content) => (await call("POST", `${commentPath(kind, id)}/reactions`, { content })).data,
    addLabels: async (number, labels) => (await call("POST", `/issues/${number}/labels`, { labels })).data,
    removeLabel: async (number, label) => (await call("DELETE", `/issues/${number}/labels/${encodeURIComponent(label)}`)).data,
    requestReviewers: async (number, reviewers) => (await call("POST", `/pulls/${number}/requested_reviewers`, { reviewers })).data,
    ready,
    replyThread: async (thread, body, mutationId) => {
      const result = await threadMutation("mutation($thread:ID!,$body:String!,$mutation:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body,clientMutationId:$mutation}){comment{id body author{__typename login} pullRequest{number}}}}",
        { thread, body, mutation: mutationId }, "addPullRequestReviewThreadReply");
      const comment = result.comment;
      if (!comment) throw new Error("Thread reply response is uncertain");
      return { ...comment, author: comment.author ? `${comment.author.login}${comment.author.__typename === "Bot" && !comment.author.login.endsWith("[bot]") ? "[bot]" : ""}` : "ghost" };
    },
    resolveThread: async (thread, mutationId) => (await threadMutation("mutation($thread:ID!,$mutation:String!){resolveReviewThread(input:{threadId:$thread,clientMutationId:$mutation}){thread{id isResolved pullRequest{number}}}}",
      { thread, mutation: mutationId }, "resolveReviewThread")).thread,
    closeIssue: async (number) => (await call("PATCH", `/issues/${number}`, { state: "closed" })).data,
    reopenIssue: async (number) => (await call("PATCH", `/issues/${number}`, { state: "open" })).data,
    closePull: async (number) => (await call("PATCH", `/pulls/${number}`, { state: "closed" })).data,
    dispatch: async (workflow, ref, request) => void await call("POST", `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs: { request: JSON.stringify(request) } }),
    cancelRun: async (id) => void await call("POST", `/actions/runs/${id}/cancel`),
    rerunFailedJobs: async (id) => void await call("POST", `/actions/runs/${id}/rerun-failed-jobs`),
  };
}
