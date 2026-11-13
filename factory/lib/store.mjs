// A data-only Git branch. Git is accessed through the API, without checking out
// project code. Mutators must be pure: a compare-and-update conflict reruns them.
import { emptyLedger, validateLedger, ProtocolError } from "./protocol.mjs";

export class GitHubError extends Error {
  constructor(status, method, path) { super(`GitHub ${method} ${path}: ${status}`); this.name = "GitHubError"; this.status = status; }
}
export class UncertainStateWrite extends Error {
  constructor(commit, cause) { super(`Cannot establish whether state commit ${commit} was applied`, { cause }); this.name = "UncertainStateWrite"; this.commit = commit; }
}
export class StateConflict extends Error {
  constructor() { super("State changed during every transaction attempt"); this.name = "StateConflict"; }
}

export const canonical = (v) => JSON.stringify(v, (_, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value, 2) + "\n";
const sha = (s) => /^[0-9a-f]{40}$/.test(s);
const encodedRef = (s) => s.split("/").map(encodeURIComponent).join("/");

export function githubData({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid repository name");
  const base = `/repos/${repo}`;
  // Git objects are immutable by SHA; refs remain fresh on every read. Keep
  // this cache local to one adapter/job and bound its serialized payload size.
  const objects = new Map(); let objectBytes = 0;
  async function call(method, path, body) {
    const immutable = method === "GET" && /^\/git\/(?:(?:commits|blobs)\/[a-f\d]{40}|trees\/[a-f\d]{40}\?recursive=1)$/.test(path);
    const cached = immutable && objects.get(path);
    if (cached) { objects.delete(path); objects.set(path, cached); return JSON.parse(cached.text); }
    const res = await fetch(`${apiUrl}${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "user-agent": "factory", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Never include request bodies or credentials in error messages. In
    // particular, do not blindly retry a write on 5xx or a network timeout.
    if (!res.ok) {
      const error = new GitHubError(res.status, method, path);
      const remaining = res.headers?.get("x-ratelimit-remaining"), reset = res.headers?.get("x-ratelimit-reset");
      if (/^\d{1,10}$/.test(remaining ?? "")) error.rateLimitRemaining = Number(remaining);
      if (/^\d{1,11}$/.test(reset ?? "")) error.rateLimitReset = Number(reset);
      if ([403, 429].includes(res.status)) {
        const data = await res.json().catch(() => null);
        if (typeof data?.message === "string" && /secondary rate limit/i.test(data.message)) error.message += " (secondary API rate limit)";
        else if (error.rateLimitRemaining === 0) error.message += " (API rate limit exhausted)";
        if (error.rateLimitReset) error.message += `; rate limit resets at ${new Date(error.rateLimitReset * 1000).toISOString()}`;
      }
      throw error;
    }
    const value = res.status === 204 ? null : await res.json();
    if (immutable) {
      const text = JSON.stringify(value), bytes = Buffer.byteLength(text), limit = 32 * 1024 * 1024;
      if (bytes <= limit) {
        while (objects.size && (objects.size >= 20000 || objectBytes + bytes > limit)) {
          const oldest = objects.keys().next().value; objectBytes -= objects.get(oldest).bytes; objects.delete(oldest);
        }
        objects.set(path, { text, bytes }); objectBytes += bytes;
      }
    }
    return value;
  }
  return {
    ref: async (branch) => (await call("GET", `/git/ref/heads/${encodedRef(branch)}`)).object.sha,
    commit: (id) => call("GET", `/git/commits/${id}`),
    tree: (id) => call("GET", `/git/trees/${id}?recursive=1`),
    blob: (id) => call("GET", `/git/blobs/${id}`),
    createTree: async (tree) => (await call("POST", "/git/trees", { tree })).sha,
    createCommit: async (tree, parent, message) => (await call("POST", "/git/commits", { tree, parents: parent ? [parent] : [], message })).sha,
    createRef: (branch, id) => call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: id }),
    advance: (branch, id) => call("PATCH", `/git/refs/heads/${encodedRef(branch)}`, { sha: id, force: false }),
    contains: async (ancestor, descendant) => {
      const comparison = await call("GET", `/compare/${ancestor}...${descendant}`);
      return ["identical", "ahead"].includes(comparison.status);
    },
  };
}

function filesFor(state) {
  validateLedger(state);
  const items = Object.keys(state.items).sort();
  const operations = Object.keys(state.operations).sort();
  return new Map([
    ["repository.json", { schemaVersion: state.schemaVersion, repositoryId: state.repositoryId,
      ...(state.factoryApp ? { factoryApp: state.factoryApp } : {}), integration: state.integration ?? null, items, operations }],
    ...items.map((k) => [`items/${k}.json`, state.items[k]]),
    ...operations.map((id) => [`operations/${id}.json`, state.operations[id]]),
  ]);
}

export function stateStore({ git, repositoryId, branch = "factory-state", maxFiles = 10000, maxBytes = 16 * 1024 * 1024 }) {
  if (branch !== "factory-state") throw new Error("Only the dedicated factory-state branch may hold the ledger");
  const missing = (reason) => new ProtocolError("corrupt", reason);

  async function load() {
    let tip;
    try { tip = await git.ref(branch); }
    catch (err) {
      if (err.status === 404) throw missing("factory-state is missing; run setup or restore it before admitting work");
      throw err;
    }
    if (!sha(tip)) throw missing("Invalid state branch tip");
    const commit = await git.commit(tip);
    const tree = await git.tree(commit.tree.sha);
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > maxFiles) throw missing("State tree is truncated or too large");
    const blobs = new Map();
    let bytes = 0;
    for (const entry of tree.tree) {
      if (entry.type === "tree") {
        if (!["items", "operations"].includes(entry.path)) throw missing("Unexpected state directory");
        continue;
      }
      if (entry.type !== "blob" || entry.mode !== "100644"
        || !/^(repository\.json|items\/(issue|pr):[1-9]\d*\.json|operations\/[a-z0-9][a-z0-9-]{0,79}\.json)$/.test(entry.path)
        || blobs.has(entry.path)) throw missing("Unexpected file in state branch");
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (bytes += entry.size) > maxBytes) throw missing("State exceeds its size limit");
      const blob = await git.blob(entry.sha);
      if (blob.encoding !== "base64" || typeof blob.content !== "string") throw missing("Invalid state blob encoding");
      const content = Buffer.from(blob.content, "base64");
      if (content.length !== entry.size || content.length > maxBytes) throw missing("State blob size does not match its tree");
      try { blobs.set(entry.path, JSON.parse(content.toString("utf8"))); }
      catch { throw missing(`Invalid JSON in ${entry.path}`); }
    }
    const metadata = blobs.get("repository.json");
    if (!metadata || metadata.repositoryId !== repositoryId || !Array.isArray(metadata.items) || !Array.isArray(metadata.operations)
      || !metadata.items.every((key) => /^(issue|pr):[1-9]\d*$/.test(key))
      || !metadata.operations.every((id) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id))) throw missing("State belongs to another repository or has invalid indexes");
    const paths = ["repository.json", ...metadata.items.map((k) => `items/${k}.json`), ...metadata.operations.map((id) => `operations/${id}.json`)];
    if (new Set(paths).size !== paths.length || paths.length !== blobs.size || !paths.every((path) => blobs.has(path))) throw missing("State index and records disagree");
    const state = { schemaVersion: metadata.schemaVersion, repositoryId, integration: metadata.integration ?? null,
      ...(Object.hasOwn(metadata, "factoryApp") ? { factoryApp: metadata.factoryApp } : {}),
      items: Object.fromEntries(metadata.items.map((k) => [k, blobs.get(`items/${k}.json`)])),
      operations: Object.fromEntries(metadata.operations.map((id) => [id, blobs.get(`operations/${id}.json`)])) };
    return { tip, state: validateLedger(state) };
  }

  async function candidate(state, parent, message) {
    const files = filesFor(state);
    const entries = [...files].map(([path, value]) => ({ path, mode: "100644", type: "blob", content: canonical(value) }));
    if (entries.length > maxFiles || entries.reduce((n, e) => n + Buffer.byteLength(e.content), 0) > maxBytes) throw missing("New state exceeds its size limit");
    const tree = await git.createTree(entries);
    const commit = await git.createCommit(tree, parent, message);
    if (!sha(commit)) throw missing("GitHub returned an invalid state commit");
    return commit;
  }

  async function observedCommit(commit, cause) {
    try {
      const tip = await git.ref(branch);
      if (tip === commit || await git.contains(commit, tip)) return true;
    } catch (error) { throw new UncertainStateWrite(commit, error); }
    throw new UncertainStateWrite(commit, cause);
  }

  return {
    load,
    // Setup is explicit. A normal read/transaction never recreates lost state.
    async initialize() {
      try { return await load(); }
      catch (err) {
        if (!(err instanceof ProtocolError && err.message.startsWith("factory-state is missing"))) throw err;
      }
      const state = emptyLedger(repositoryId);
      const commit = await candidate(state, null, "Initialize factory state");
      try { await git.createRef(branch, commit); }
      catch (err) {
        if ([409, 422].includes(err.status)) return load();
        await observedCommit(commit, err);
      }
      return { tip: commit, state };
    },
    async transact(mutate, { attempts = 3, message = "Reconcile factory state" } = {}) {
      if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw new Error("Invalid transaction attempt limit");
      for (let attempt = 0; attempt < attempts; attempt++) {
        const before = await load();
        const next = await mutate(structuredClone(before.state));
        validateLedger(next);
        if (next.repositoryId !== repositoryId) throw missing("Cannot change repository identity");
        if (before.state.factoryApp && canonical(next.factoryApp) !== canonical(before.state.factoryApp)) throw missing("Cannot change the recorded factory App identity");
        if (canonical(next) === canonical(before.state)) return before;
        const commit = await candidate(next, before.tip, message);
        try {
          await git.advance(branch, commit);
          return { tip: commit, state: next };
        } catch (err) {
          // A non-fast-forward rejection is safe to reread and recompute.
          // A timeout/5xx may have applied the commit; do not replay on absence.
          if ([409, 422].includes(err.status)) {
            if (await git.ref(branch) !== before.tip) continue;
            throw err;
          }
          await observedCommit(commit, err);
          // The candidate is an ancestor of the latest tip. Return current
          // state, not a stale copy that could hide a subsequent transaction.
          return load();
        }
      }
      throw new StateConflict();
    },
  };
}
