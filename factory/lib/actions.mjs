// Results are untrusted data from one recorded Actions run and attempt. Download
// credentials never follow the artifact service's signed redirect.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { GitHubError } from "./store.mjs";
import { readProposal } from "./artifact.mjs";
import { validExecution } from "./usage.mjs";
import { MAX_ATTACHMENT_PACK } from "./attachments.mjs";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const positive = (n) => /^[1-9]\d*$/.test(String(n));
export class InvalidResult extends Error {
  constructor(message) { super(message); this.name = "InvalidResult"; this.code = "invalid-result"; }
}
export function resultName(op) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(op.id) || !positive(op.owner?.id)
    || !Number.isSafeInteger(op.owner?.attempt) || op.owner.attempt < 1) throw new Error("Invalid result owner");
  return `factory-${op.id}-${op.owner.id}-${op.owner.attempt}`;
}
export function runProvenance(run, op, repositoryId, defaultBranch) {
  if (String(run.id) !== op.owner?.id || run.run_attempt !== op.owner.attempt
    || String(run.repository?.id) !== repositoryId || String(run.head_repository?.id) !== repositoryId
    || run.path !== op.worker.workflowPath || run.head_sha !== op.worker.entrySha
    || run.head_branch !== defaultBranch || run.event !== "workflow_dispatch") throw new Error("Result workflow provenance does not match its recorded operation");
  return { id: String(run.id), attempt: run.run_attempt, status: run.status,
    conclusion: run.conclusion ?? null, startedAt: run.run_started_at ?? null };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
// Accept only the named flat result files, with sizes bounded before inflate.
export function resultFiles(zip, { maxBundleBytes = 50 * 1024 * 1024, inspection = false } = {}) {
  const limits = inspection ? { "factory-app-inspection.json": 64 * 1024 }
    : { "proposal.json": 1024 * 1024, "proposal.bundle": maxBundleBytes, "screenshots.json": MAX_ATTACHMENT_PACK };
  const required = inspection ? "factory-app-inspection.json" : "proposal.json";
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > (inspection ? 128 * 1024 : maxBundleBytes + MAX_ATTACHMENT_PACK + 2 * 1024 * 1024)) throw new Error("Invalid artifact archive size");
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error("Invalid artifact ZIP directory");
  const count = zip.readUInt16LE(end + 10), directorySize = zip.readUInt32LE(end + 12), start = zip.readUInt32LE(end + 16);
  if (count < 1 || count > Object.keys(limits).length || zip.readUInt16LE(end + 8) !== count || start + directorySize !== end) throw new Error("Unexpected artifact ZIP layout");
  const files = new Map(), ranges = [];
  let cursor = start;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16), compressed = zip.readUInt32LE(cursor + 20), size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28), extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16, local = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > end || zip.readUInt16LE(cursor + 34) !== 0 || flags & ~0x808 || ![0, 8].includes(method)
      || (mode & 0xf000) && (mode & 0xf000) !== 0x8000) throw new Error("Unsupported ZIP entry");
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const limit = Object.hasOwn(limits, name) ? limits[name] : 0;
    if (!limit || files.has(name) || size > limit || local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50
      || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) throw new Error("Unexpected artifact file");
    const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + localName + localExtra, dataEnd = dataStart + compressed;
    if (zip.subarray(local + 30, local + 30 + localName).toString("utf8") !== name || dataEnd > start
      || ranges.some(([a, b]) => local < b && dataEnd > a)) throw new Error("Overlapping or mismatched ZIP entries");
    if (!(flags & 8) && (zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== compressed
      || zip.readUInt32LE(local + 22) !== size)) throw new Error("ZIP header sizes do not match");
    const packed = zip.subarray(dataStart, dataEnd);
    const bytes = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: limit });
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error("Artifact file checksum does not match");
    files.set(name, bytes); ranges.push([local, dataEnd]); cursor = next;
  }
  if (cursor !== end || !files.has(required)) throw new Error("Incomplete artifact archive");
  return files;
}

export function actionsClient({ token, repo, apiUrl = "https://api.github.com", fetch = globalThis.fetch,
  temporaryRoot = tmpdir(), maxBundleBytes = 50 * 1024 * 1024 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  const root = `${apiUrl}/repos/${repo}`, origin = new URL(apiUrl).origin;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory" };
  async function response(path) {
    const url = path.startsWith("https://") ? path : `${root}${path}`;
    if (new URL(url).origin !== origin || !url.startsWith(`${root}/`)) throw new Error("Unexpected Actions API target");
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (!res.ok && res.status !== 302) throw new GitHubError(res.status, "GET", new URL(url).pathname);
    return res;
  }
  async function list(path, pick) {
    const all = [], seen = new Set();
    let next = path;
    while (next) {
      if (seen.has(next) || seen.size >= 10000) throw new Error("Invalid artifact pagination");
      seen.add(next);
      const res = await response(next), data = await res.json();
      const values = pick(data);
      if (!Array.isArray(values)) throw new Error("Incomplete Actions listing");
      all.push(...values);
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return all;
  }
  async function inspect(op, { repositoryId, defaultBranch }) {
    const run = await (await response(`/actions/runs/${op.owner.id}/attempts/${op.owner.attempt}`)).json();
    const owner = runProvenance(run, op, repositoryId, defaultBranch);
    if (owner.status === "in_progress") {
      const jobs = await list(`/actions/runs/${op.owner.id}/attempts/${op.owner.attempt}/jobs?per_page=100`, (d) => d.jobs);
      const name = op.mode === "update" ? "factory-update" : "factory-worker";
      const worker = jobs.filter((j) => j.name === name || j.name?.endsWith(` / ${name}`));
      if (worker.length > 1) throw new Error("Multiple jobs claim the worker role");
      owner.status = worker[0]?.status === "in_progress" || worker[0]?.status === "completed" && worker[0].conclusion !== "skipped"
        ? "in_progress" : "queued";
      owner.startedAt = owner.status === "in_progress" ? worker[0]?.started_at ?? null : null;
    } else if (owner.status !== "completed") owner.status = "queued";
    if (owner.status !== "completed") return { owner, inspected: false, available: false };
    const artifacts = (await list(`/actions/runs/${op.owner.id}/artifacts?per_page=100`, (d) => d.artifacts)).filter((a) => a.name === resultName(op));
    if (artifacts.length > 1) throw new Error("Several artifacts claim the same operation/attempt");
    const a = artifacts[0];
    if (!a) return { owner, inspected: true, available: false };
    if (String(a.workflow_run?.id) !== op.owner.id || String(a.workflow_run.repository_id) !== repositoryId
      || String(a.workflow_run.head_repository_id) !== repositoryId || a.workflow_run.head_sha !== op.worker.entrySha
      || a.workflow_run.head_branch !== defaultBranch || !positive(a.id) || !/^sha256:[a-f0-9]{64}$/.test(a.digest)
      || !Number.isSafeInteger(a.size_in_bytes) || a.size_in_bytes < 0 || a.size_in_bytes > maxBundleBytes + MAX_ATTACHMENT_PACK + 2 * 1024 * 1024) throw new Error("Artifact metadata does not match its owner");
    return { owner, inspected: true, available: !a.expired, expired: a.expired === true,
      artifact: { id: String(a.id), digest: a.digest, run: { id: owner.id, attempt: owner.attempt }, repositoryId,
        workflowPath: op.worker.workflowPath, headSha: op.worker.entrySha, expired: a.expired === true } };
  }
  async function downloadArchive(artifact, maxBytes = maxBundleBytes + MAX_ATTACHMENT_PACK + 2 * 1024 * 1024) {
    if (!positive(artifact?.id) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 22 || maxBytes > maxBundleBytes + MAX_ATTACHMENT_PACK + 2 * 1024 * 1024) throw new Error("Invalid artifact download identity or limit");
    const res = await response(`/actions/artifacts/${artifact.id}/zip`);
    if (res.status !== 302) throw new Error("Artifact service did not return a signed download");
    const location = new URL(res.headers.get("location"));
    if (location.protocol !== "https:" || location.username || location.password) throw new Error("Invalid artifact download URL");
    const archive = await fetch(location.href, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!archive.ok || Number(archive.headers.get("content-length") ?? 0) > maxBytes) throw new Error("Artifact download failed or is too large");
    const chunks = []; let size = 0;
    for await (const chunk of archive.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("Artifact download exceeds its limit");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== artifact.digest) throw new InvalidResult("Artifact archive digest does not match GitHub metadata");
    return bytes;
  }
  async function download(op, context, accepted = null) {
    const facts = await inspect(op, context);
    if (!facts.available) throw new Error("The recorded result artifact is unavailable");
    if (accepted && (facts.artifact.id !== accepted.id || facts.artifact.digest !== accepted.digest)) throw new Error("The accepted artifact was substituted");
    const bytes = await downloadArchive(facts.artifact);
    let files;
    try { files = resultFiles(bytes, { maxBundleBytes }); }
    catch { throw new InvalidResult("Worker result archive failed validation"); }
    const directory = mkdtempSync(join(temporaryRoot, "factory-result-"));
    try {
      for (const [name, content] of files) writeFileSync(join(directory, name), content, { flag: "wx", mode: 0o600 });
      return { ...readProposal(directory, { operation: op, run: op.owner, maxBundleBytes }), artifact: facts.artifact,
        dispose: () => rmSync(directory, { recursive: true, force: true }) };
    } catch { rmSync(directory, { recursive: true, force: true }); throw new InvalidResult("Worker proposal or bundle failed validation"); }
  }
  async function measure(op, { repositoryId, defaultBranch }) {
    const run = await (await response(`/actions/runs/${op.owner.id}/attempts/${op.owner.attempt}`)).json();
    const owner = runProvenance(run, op, repositoryId, defaultBranch);
    if (owner.status !== "completed") return null;
    const jobs = await list(`/actions/runs/${op.owner.id}/attempts/${op.owner.attempt}/jobs?per_page=100`, (d) => d.jobs);
    const name = op.mode === "update" ? "factory-update" : "factory-worker";
    const matches = jobs.filter((j) => j.name === name || j.name?.endsWith(` / ${name}`));
    if (matches.length !== 1) throw new Error("Execution measurement needs exactly one worker job");
    const job = matches[0];
    if (!positive(job.id) || String(job.run_id) !== op.owner.id || job.run_attempt !== op.owner.attempt
      || job.head_sha !== op.worker.entrySha || job.status !== "completed" || !Array.isArray(job.labels)
      || !job.labels.includes(op.worker.runner)) throw new Error("Execution job provenance does not match its owner");
    const ran = Number.isSafeInteger(job.runner_id) && job.runner_id > 0 && typeof job.runner_name === "string" && job.runner_name.length > 0;
    // A queued/cancelled job may have started_at set before any runner exists.
    // Its absence alone never establishes a zero-cost execution.
    const neverRan = job.runner_id === 0 && !job.runner_name && ["skipped", "cancelled"].includes(job.conclusion)
      && Array.isArray(job.steps) && job.steps.every((s) => !s.started_at && !s.completed_at);
    if (!ran && !neverRan) throw new Error("Execution runner assignment is unknown");
    const value = { source: "actions-job", run: { id: owner.id, attempt: owner.attempt }, jobId: String(job.id), runner: op.worker.runner,
      ran, startedAt: ran ? job.started_at : null, completedAt: ran ? job.completed_at : null,
      durationMs: ran ? Date.parse(job.completed_at) - Date.parse(job.started_at) : 0 };
    if (!validExecution(value, op)) throw new Error("Execution job timestamps are incomplete");
    return value;
  }
  return { inspect, download, measure, downloadArchive };
}
