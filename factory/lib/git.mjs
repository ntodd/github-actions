// Git is a data transport here. Publisher calls run in a fresh bare repository,
// without project hooks, configuration, filters, helpers, worktrees or submodules.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validBranch } from "./protocol.mjs";
const SHA = /^[a-f0-9]{40}$/;
export class GitError extends Error {
  constructor(command, status) { super(`Git ${command} failed (status ${status ?? "unknown"})`); this.name = "GitError"; this.status = status; }
}
export function gitCommand(cwd, args, { token = null, remote = null, input, allowFailure = false, binary = "/usr/bin/git", timeout = 120000 } = {}) {
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" });
  if (token) {
    if (!remote?.startsWith("https://")) throw new Error("Credentials require an HTTPS repository URL");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${remote}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  const configs = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper=", "http.followRedirects=false",
    "protocol.allow=never", "protocol.https.allow=always", "protocol.file.allow=always", "gc.auto=0", "maintenance.auto=false", "fetch.fsckObjects=true", "transfer.fsckObjects=true"];
  const result = spawnSync(binary, [...configs.flatMap((c) => ["-c", c]), ...args], { cwd, env, input, encoding: null, maxBuffer: 32 * 1024 * 1024, timeout });
  if (result.error || (!allowFailure && result.status !== 0)) throw new GitError(args[0], result.status);
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}
const text = (value) => value.stdout.toString("utf8").trim();
export function repositoryUrl(repo, serverUrl = "https://github.com") {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Invalid GitHub server URL");
  return `${url.origin}/${repo}.git`;
}
export function exportRef(operationId) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(operationId)) throw new Error("Invalid operation ID");
  return `refs/factory/exports/${operationId}`;
}
export function verifyAncestry(run, ancestor, descendant) {
  if (![ancestor, descendant].every((s) => SHA.test(s))) throw new Error("Invalid ancestry commit");
  const result = run(["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true });
  if (result.status === 1) return false;
  if (result.status !== 0) throw new GitError("merge-base", result.status);
  return true;
}

export function cleanGitWriter({ remote, readToken, writeToken, bundleFile, allowLocal = false,
  limits = {}, temporaryRoot = tmpdir(), binary = "/usr/bin/git" }) {
  const url = new URL(remote, "file:///");
  if (!(url.protocol === "https:" && !url.username && !url.password) && !(allowLocal && (remote.startsWith("/") || url.protocol === "file:"))) throw new Error("Unsupported Git remote");
  const directory = mkdtempSync(join(temporaryRoot, "factory-publisher-"));
  const run = (args, options = {}) => gitCommand(directory, args, { binary, ...options });
  run(["init", "--bare", "--quiet", "."]);
  const maxBlob = limits.maxBlobBytes ?? 25 * 1024 * 1024;
  const maxTotal = limits.maxObjectBytes ?? 200 * 1024 * 1024;
  const maxCommits = limits.maxCommits ?? 200;
  let imported = null;
  function fetchRemote(commits) {
    const distinct = [...new Set(commits)];
    if (!distinct.every((s) => SHA.test(s))) throw new Error("Invalid fetch target");
    run(["fetch", "--quiet", "--depth=256", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", remote, ...distinct], { token: readToken, remote });
  }
  function head(branch) {
    if (!validBranch(branch)) throw new Error("Invalid branch");
    const lines = text(run(["ls-remote", "--refs", remote, `refs/heads/${branch}`], { token: readToken, remote })).split("\n").filter(Boolean);
    if (lines.length > 1) throw new Error("Ambiguous branch lookup");
    const sha = lines.length ? lines[0].split(/\s+/)[0] : null;
    if (sha !== null && !SHA.test(sha)) throw new Error("Invalid remote head");
    return sha;
  }
  function entry(commit, path) {
    return run(["ls-tree", "-z", commit, "--", path]).stdout.toString("hex");
  }
  function validateObjects(op, effect) {
    const objects = text(run(["rev-list", "--objects", "--no-object-names", effect.commit, "--not", op.target.head ?? op.base.sha, op.base.sha]));
    let total = 0, count = 0;
    for (const line of text(run(["cat-file", "--batch-check=%(objecttype) %(objectsize)"], { input: `${objects}\n` })).split("\n")) {
      if (!line) continue;
      const [kind, rawSize] = line.split(" "), size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size < 0 || !["blob", "tree", "commit", "tag"].includes(kind)) throw new Error("Invalid Git object");
      total += size; count++;
      if (count > 100000 || total > maxTotal || (kind === "blob" && size > maxBlob)) throw new Error("Proposal exceeds Git object limits");
    }
    total = 0; count = 0;
    for (const line of text(run(["cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"])).split("\n")) {
      if (!line) continue;
      const size = Number(line);
      if (!Number.isSafeInteger(size) || size < 0 || ++count > 1000000 || (total += size) > (limits.maxHistoryObjectBytes ?? 2 * 1024 * 1024 * 1024)) throw new Error("Fetched history exceeds Git object limits");
    }
  }
  function importBundle(op, effect) {
    if (imported === effect.commit) return;
    if (!bundleFile || (!lstatSync(bundleFile).isFile() || lstatSync(bundleFile).isSymbolicLink()) || lstatSync(bundleFile).size > (limits.maxBundleBytes ?? 50 * 1024 * 1024)) throw new Error("Proposal bundle is missing or too large");
    const ref = exportRef(op.id);
    const heads = text(run(["bundle", "list-heads", resolve(bundleFile)])).split("\n");
    if (heads.length !== 1 || heads[0] !== `${effect.commit} ${ref}`) throw new Error("Bundle does not advertise only the recorded proposal");
    fetchRemote([op.base.sha, op.target.head ?? op.base.sha]);
    run(["bundle", "verify", resolve(bundleFile)]);
    run(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", resolve(bundleFile), `${ref}:refs/factory/imported`]);
    run(["fsck", "--strict", "--no-reflogs"]);
    validateObjects(op, effect);
    imported = effect.commit;
  }
  return {
    directory,
    seed(op) { fetchRemote([op.base.sha, op.target.head ?? op.base.sha]); },
    async validate(effect, op) {
      if (effect.type !== "push" || !SHA.test(effect.commit) || !SHA.test(op.base.sha) || !validBranch(effect.branch)
        || effect.branch !== op.target.branch || effect.branch === op.base.ref || effect.branch === "factory-state"
        || effect.expectedHead !== op.target.head || effect.baseSha !== op.base.sha) throw new Error("Push is outside the recorded operation");
      importBundle(op, effect);
      const ancestor = op.target.head ?? op.base.sha;
      if (!verifyAncestry(run, ancestor, effect.commit) || !verifyAncestry(run, op.base.sha, effect.commit)) throw new Error("Proposal does not extend the recorded head and base");
      if (effect.commit === ancestor) throw new Error("A push must change the recorded head");
      const commits = text(run(["rev-list", `--max-count=${maxCommits + 1}`, effect.commit, "--not", ancestor, op.base.sha])).split("\n").filter(Boolean);
      if (commits.length > maxCommits) throw new Error("Proposal contains too many new commits");
      for (const commit of commits) {
        const parents = text(run(["rev-list", "--parents", "-n", "1", commit])).split(" ").slice(1);
        if (!parents.length) throw new Error("Proposal introduced an unrelated root commit");
        const paths = run(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parents[0], commit]).stdout.toString("utf8").split("\0").filter(Boolean);
        for (const path of paths) {
          if (path.includes("\ufffd") || path.split("/").some((part) => !part || [".", "..", ".git"].includes(part.toLowerCase()))) throw new Error("Proposal contains an unsafe path");
          if (path.toLowerCase().startsWith(".github/workflows/") && entry(commit, path) !== entry(op.base.sha, path)) throw new Error("Proposal changes a workflow outside the approved base");
        }
      }
    },
    async inspect(effect) {
      const current = head(effect.branch);
      if (!current) return { outcome: "unknown" };
      if (current === effect.commit) return { outcome: "applied", evidence: { kind: "branch-head", commit: effect.commit } };
      try {
        fetchRemote([current]);
        if (verifyAncestry(run, effect.commit, current)) return { outcome: "applied", evidence: { kind: "commit-ancestor", commit: effect.commit } };
      } catch { /* Missing objects or failed reads do not prove non-application. */ }
      return { outcome: "unknown" };
    },
    async apply(effect, op) {
      // Revalidate ancestry immediately before the conditional ref update.
      await this.validate(effect, op);
      const old = effect.expectedHead ?? "";
      // The lease supplies expected-old CAS. Ancestry was independently checked,
      // so the accepted update can only add commits; existing history is retained.
      const result = run(["push", "--porcelain", "--no-verify", `--force-with-lease=refs/heads/${effect.branch}:${old}`,
        remote, `${effect.commit}:refs/heads/${effect.branch}`], { token: writeToken, remote, allowFailure: true });
      if (result.status === 0) return { outcome: "applied", evidence: { kind: "branch-head", commit: effect.commit } };
      // A Git protocol rejection is definitive for this request. A disconnected
      // transport may have applied the write; preserve its unknown outcome.
      if (/\[(?:remote )?rejected\]/.test(`${result.stdout}\n${result.stderr}`)) {
        return { outcome: "rejected", evidence: { kind: "git-rejection" } };
      }
      return { outcome: "unknown" };
    },
    dispose() { rmSync(directory, { recursive: true, force: true }); },
  };
}
