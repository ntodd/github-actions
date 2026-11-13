// Administrator-only REST adapter. Neither this token nor the gh subprocess
// used for secret encryption is ever passed to a worker or shared workflow.
import { spawnSync } from "node:child_process";
import { GitHubError } from "./store.mjs";
import { appJwt } from "../../agent-ready/lib/app-token.mjs";
import { LIVE_RUN_STATUSES } from "./runtime-guard.mjs";

export function runGh(args, input = undefined) {
  const result = spawnSync("gh", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_HOST: "github.com" } });
  if (result.error || result.status !== 0) throw new Error(`gh ${args[0] ?? "command"} failed; check authentication and permissions`);
  return result.stdout;
}

export async function inspectSetupApp({ appId, privateKey, repo, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(appId) || appId < 1 || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid setup App/repository identity");
  const headers = { authorization: `Bearer ${appJwt({ appId, privateKey })}`, accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28", "user-agent": "factory-setup" };
  const read = async (path) => {
    const result = await fetchImpl(`https://api.github.com${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!result.ok) throw new GitHubError(result.status, "GET", path);
    return result.json();
  };
  const [app, installation] = await Promise.all([read("/app"), read(`/repos/${repo}/installation`)]);
  if (app.id !== appId || installation.app_id !== appId || !Number.isSafeInteger(installation.id)
    || installation.suspended_at || !installation.permissions) throw new Error("The requested App is not actively installed on this repository");
  // Return only public metadata. In particular, never serialize a JWT/key.
  return { app: { id: app.id, slug: app.slug, permissions: app.permissions }, installation: {
    id: installation.id, app_id: installation.app_id, permissions: installation.permissions,
    repository_selection: installation.repository_selection, suspended_at: installation.suspended_at ?? null,
  } };
}

export function setupClient({ token, repo, fetchImpl = fetch, gh = runGh }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Administrator credentials and repository are required");
  const base = `https://api.github.com/repos/${repo}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28", "user-agent": "factory-setup" };
  async function request(method, path, body) {
    const url = path.startsWith("https:") ? path : `${base}${path}`;
    const normalized = new URL(url).href;
    if (!normalized.startsWith(`${base}/`) && normalized !== base) throw new Error("Unexpected setup API target");
    const response = await fetchImpl(url, { method, headers: body ? { ...headers, "content-type": "application/json" } : headers,
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new GitHubError(response.status, method, new URL(url).pathname);
    return { value: response.status === 204 ? null : await response.json(), link: response.headers.get("link") };
  }
  const api = async (method, path, body) => (await request(method, path, body)).value;
  async function list(path, field) {
    let next = path; const result = [], seen = new Set();
    while (next) {
      if (seen.has(next) || seen.size >= 1000) throw new Error("Invalid setup API pagination");
      seen.add(next);
      const { value, link } = await request("GET", next), rows = field ? value[field] : value;
      if (!Array.isArray(rows)) throw new Error("Incomplete setup API listing");
      result.push(...rows); next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];
    }
    return result;
  }
  const ref = (branch) => branch.split("/").map(encodeURIComponent).join("/");
  return {
    repository: () => api("GET", ""), settings: (body) => api("PATCH", "", body),
    rulesets: async () => Promise.all((await list("/rulesets?includes_parents=false&per_page=100")).map((r) => api("GET", `/rulesets/${r.id}`))),
    createRuleset: (rule) => api("POST", "/rulesets", rule), updateRuleset: (id, rule) => api("PUT", `/rulesets/${id}`, rule),
    labels: () => list("/labels?per_page=100"), createLabel: (label) => api("POST", "/labels", label),
    updateLabel: (name, label) => api("PATCH", `/labels/${encodeURIComponent(name)}`, label),
    variable: (name) => api("GET", `/actions/variables/${name}`),
    createVariable: (data) => api("POST", "/actions/variables", data), updateVariable: (name, data) => api("PATCH", `/actions/variables/${name}`, data),
    secretNames: async () => (await list("/actions/secrets?per_page=100", "secrets")).map((s) => s.name),
    setSecret: async (name, value) => {
      if (!["AGENT_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SETUP_SECRETS", "AGENT_ATTACH_TOKEN"].includes(name)
        || typeof value !== "string" || !value || Buffer.byteLength(value) > 48 * 1024) throw new Error("Invalid setup secret");
      await gh(["secret", "set", name, "--repo", repo], value);
      return { name, written: true };
    },
    workflows: () => list("/actions/workflows?per_page=100", "workflows"),
    run: (id, attempt) => {
      if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid inspection run identity");
      return api("GET", `/actions/runs/${id}/attempts/${attempt}`);
    },
    jobs: (id, attempt) => {
      if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid inspection run identity");
      return list(`/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, "jobs");
    },
    artifacts: (id) => {
      if (!/^[1-9]\d*$/.test(String(id))) throw new Error("Invalid inspection run identity");
      return list(`/actions/runs/${id}/artifacts?per_page=100`, "artifacts");
    },
    branchRules: (branch) => list(`/rules/branches/${encodeURIComponent(branch)}?per_page=100`),
    liveWorkflowRuns: async (id) => {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid workflow identity");
      const rows = await Promise.all(LIVE_RUN_STATUSES.map(async (status) => {
        const data = await api("GET", `/actions/workflows/${id}/runs?status=${status}&per_page=1`);
        if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs)
          || data.total_count === 0 && data.workflow_runs.length || data.total_count > 0 && !data.workflow_runs.length) throw new Error("Incomplete live workflow-run count");
        return data.total_count ? data.workflow_runs.slice(0, 1) : [];
      }));
      return rows.flat();
    },
    openPulls: () => list("/pulls?state=open&per_page=100"),
    openIssues: async () => (await list("/issues?state=open&per_page=100")).filter((i) => !i.pull_request),
    branchSha: async (branch) => (await api("GET", `/git/ref/heads/${ref(branch)}`)).object.sha,
    resolveRef: async (value) => (await api("GET", `/commits/${encodeURIComponent(value)}`)).sha,
    commit: (sha) => api("GET", `/git/commits/${sha}`),
    createTree: (tree, baseTree) => api("POST", "/git/trees", { base_tree: baseTree, tree }),
    createCommit: (tree, parent) => api("POST", "/git/commits", { message: "Configure factory issue handling", tree, parents: [parent] }),
    createBranch: (branch, sha) => api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha }),
    fileAt: async (path, sha) => {
      if (!/^[a-f\d]{40}$/.test(sha) || !/^[\w./-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Setup files must be read at a pinned commit");
      const file = await api("GET", `/contents/${path}?ref=${sha}`);
      if (file.type !== "file" || file.encoding !== "base64" || !Number.isSafeInteger(file.size) || file.size > 128 * 1024) throw new Error("Invalid setup file");
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.length !== file.size) throw new Error("Incomplete setup file");
      return bytes.toString("utf8");
    },
    pullsFor: (branch, baseBranch) => list(`/pulls?${new URLSearchParams({ state: "all", head: `${repo.split("/")[0]}:${branch}`, base: baseBranch, per_page: "100" })}`),
    createPull: (data) => api("POST", "/pulls", { ...data, draft: data.draft === true, maintainer_can_modify: false }),
    checks: async (sha) => ({ check_runs: await list(`/commits/${sha}/check-runs?per_page=100`, "check_runs") }),
    statuses: (sha) => list(`/commits/${sha}/statuses?per_page=100`),
  };
}
