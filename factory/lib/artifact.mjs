// A worker exports data only: a proposal and optionally an incremental bundle.
// These files contain no credentials, session home directories or executable
// publisher instructions. The clean job revalidates every field and Git object.
import { openSync, closeSync, readFileSync, writeFileSync, fstatSync, lstatSync, constants, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pullRequestText } from "./effects.mjs";
import { replyProposal } from "./threads.mjs";
import { gitCommand, exportRef, verifyAncestry } from "./git.mjs";
const SHA = /^[a-f0-9]{40}$/;
export const bundleDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function plainFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Artifact file is not a bounded regular file");
    const content = readFileSync(fd);
    if (content.length !== stat.size) throw new Error("Artifact changed during the read");
    return content;
  } finally { closeSync(fd); }
}
const text = (result) => result.stdout.toString("utf8").trim();

export function exportProposal({ cwd, directory, operation: op, run, outcome }) {
  if (!op || !SHA.test(op.base?.sha) || (op.target?.head !== null && !SHA.test(op.target?.head))) throw new Error("Invalid worker assignment");
  if (!run || typeof run.id !== "string" || !/^[1-9]\d*$/.test(run.id) || !Number.isSafeInteger(run.attempt) || run.attempt < 1) throw new Error("Invalid worker run identity");
  if (!outcome || !["ready", "needs-you", "no-change", "failed"].includes(outcome.status)) throw new Error("Invalid worker outcome");
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Artifact directory must be a real directory");
  const command = (args, options) => gitCommand(cwd, args, options);
  if (outcome.status === "needs-you" && !String(outcome.reason ?? "").trim()) throw new Error("A needs-you outcome must ask a concrete question");
  const head = text(command(["rev-parse", "--verify", "HEAD^{commit}"]));
  const ancestor = op.target.head ?? op.base.sha;
  const proposal = { schemaVersion: 1, operationId: op.id, run: { id: run.id, attempt: run.attempt },
    outcome: outcome.status, reason: String(outcome.reason ?? "").slice(0, 16000), effects: [],
    report: String(outcome.report ?? "").slice(0, 60000), tests: Array.isArray(outcome.tests) ? outcome.tests.slice(0, 100) : [] };
  if (outcome.status === "ready" && head !== ancestor) {
    if (command(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).stdout.length) throw new Error("Worker must commit its changes before exporting");
    if (!verifyAncestry(command, ancestor, head) || !verifyAncestry(command, op.base.sha, head)) throw new Error("Worker proposal must extend its recorded head and base");
    const ref = exportRef(op.id), path = join(directory, "proposal.bundle");
    command(["update-ref", ref, head]);
    try { command(["bundle", "create", path, ref, `^${ancestor}`, `^${op.base.sha}`]); }
    finally { command(["update-ref", "-d", ref]); }
    const digest = bundleDigest(plainFile(path, 50 * 1024 * 1024));
    proposal.bundle = { file: "proposal.bundle", digest, ref, commit: head };
    proposal.effects.push({ id: "push", type: "push", branch: op.target.branch,
      expectedHead: op.target.head, commit: head, baseSha: op.base.sha });
  } else if (outcome.status === "ready") proposal.outcome = "no-change";
  // PR prose is data for the trusted controller. It does not determine issue
  // membership or grant permission to modify an existing human PR's metadata.
  if (op.mode === "build" && proposal.outcome === "ready") proposal.pullRequest = pullRequestText({
    title: String(outcome.title ?? "").slice(0, 256), body: String(outcome.body ?? "").slice(0, 60000),
  });
  if (outcome.replies !== undefined) {
    if (!Array.isArray(outcome.replies) || outcome.replies.length > 50 || outcome.replies.length
      && (!["respond", "resolve"].includes(op.mode) || !["ready", "no-change"].includes(proposal.outcome))) throw new Error("Replies exceed the worker assignment");
    proposal.replies = outcome.replies.map(replyProposal);
  }
  writeFileSync(join(directory, "proposal.json"), JSON.stringify(proposal, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return proposal;
}

export function readProposal(directory, { operation: op, run, maxBundleBytes = 50 * 1024 * 1024 }) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Invalid artifact directory");
  const proposal = JSON.parse(plainFile(join(directory, "proposal.json"), 1024 * 1024).toString("utf8"));
  if (proposal.schemaVersion !== 1 || proposal.operationId !== op.id || proposal.run?.id !== run.id
    || proposal.run?.attempt !== run.attempt || !Array.isArray(proposal.effects) || proposal.effects.length > 20
    || !["ready", "needs-you", "no-change", "failed"].includes(proposal.outcome)) throw new Error("Artifact does not belong to the assigned operation/run");
  const push = proposal.effects.find((e) => e.type === "push");
  let bundleFile = null;
  if (push) {
    const b = proposal.bundle;
    if (!b || b.file !== "proposal.bundle" || b.ref !== exportRef(op.id) || b.commit !== push.commit
      || !SHA.test(b.commit) || !/^sha256:[a-f0-9]{64}$/.test(b.digest)) throw new Error("Invalid bundle manifest");
    bundleFile = join(directory, "proposal.bundle");
    if (bundleDigest(plainFile(bundleFile, maxBundleBytes)) !== b.digest) throw new Error("Bundle digest does not match the proposal");
  } else if (proposal.bundle) throw new Error("Unexpected bundle without a code proposal");
  return { proposal, bundleFile };
}
