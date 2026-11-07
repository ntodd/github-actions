// The handful of GitHub REST calls flake-hunt makes, over fetch, so the
// actions need no npm install.

const LABEL_COLOR = "d93f0b";
const LABEL_DESCRIPTION = "A test that fails some runs and passes others";

export function client({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  async function request(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "flake-hunt",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status} on ${method} ${path}: ${data?.message ?? "no message"}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    async listIssues(label) {
      const all = [];
      for (let page = 1; ; page++) {
        const q = new URLSearchParams({ labels: label, state: "all", per_page: "100", page: String(page) });
        const batch = await request("GET", `/repos/${repo}/issues?${q}`);
        all.push(...batch.filter((i) => !i.pull_request));
        if (batch.length < 100) return all;
      }
    },

    async ensureLabel(name) {
      try {
        await request("GET", `/repos/${repo}/labels/${encodeURIComponent(name)}`);
        return;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      try {
        await request("POST", `/repos/${repo}/labels`, { name, color: LABEL_COLOR, description: LABEL_DESCRIPTION });
      } catch (e) {
        // Another job calling flake-hunt in the same run made it first.
        if (e.status !== 422) throw e;
      }
    },

    createIssue({ title, body, labels }) {
      return request("POST", `/repos/${repo}/issues`, { title, body, labels });
    },

    comment(number, body) {
      return request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    },

    reopen(number) {
      return request("PATCH", `/repos/${repo}/issues/${number}`, { state: "open" });
    },

    async defaultBranch() {
      return (await request("GET", `/repos/${repo}`)).default_branch;
    },
  };
}
