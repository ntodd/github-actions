import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommand } from "../lib/git.mjs";
import { parseConfig } from "../lib/config.mjs";
import { runWorker, workerEnvironment } from "../lib/worker.mjs";
import { readProposal } from "../lib/artifact.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) => gitCommand(root, args);
  git(["init", "--quiet", "--initial-branch=main"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(root, "code.txt"), "original"); git(["add", "."]); git(["commit", "--quiet", "-m", "Base"]);
  const head = git(["rev-parse", "HEAD"]).stdout.toString("utf8").trim();
  const run = { id: "100", attempt: 1 }, config = parseConfig("trusted-users: [ntodd]");
  const op = { id: "op-1", item: "issue:7", phase: "claimed", mode: "respond", generation: 0, revision: "e".repeat(64),
    owner: run, target: { number: 9, branch: "factory/issue-7", head }, base: { ref: "main", sha: head } };
  const fresh = { valid: true, paused: false, generation: 0, revision: op.revision, head, owner: run,
    issue: { title: "Fix it", body: "Accepted task", user: { login: "ntodd" } }, feedback: [] };
  return { root, git, run, fresh, args: { assignment: { operation: op, item: { evidence: {}, effort: "medium" }, config }, cwd: root,
    stateDir: join(root, ".git", "factory-state"), resultDir: join(root, ".git", "factory-result"), run, readToken: "read-only", readFresh: async () => fresh, log() {} } };
}

test("workers reread feedback between phases and export only committed code", async (t) => {
  const f = fixture(t), prompts = [];
  f.args.readFresh = async () => ({ ...f.fresh, feedback: [{ sourceId: "issue-comment:1", revision: `${prompts.length}`, authority: "instruction", body: prompts.length ? "Fix the fixture instead" : "Original direction" }] });
  f.args.invoke = async (phase) => {
    prompts.push(phase.prompt);
    assert.equal(phase.token, "read-only");
    assert.ok(phase.timeoutMs > 0);
    if (phase.phase === "work") {
      writeFileSync(join(f.root, "code.txt"), "fixed"); f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "Fix"]);
    }
    return { outcome: { status: "ready", report: "Tests passed", tests: ["unit suite"] }, turns: 2, cost: 0.01 };
  };
  const proposal = await runWorker(f.args);
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /Fix the fixture instead/);
  assert.equal(proposal.effects[0].type, "push");
  assert.equal(proposal.metrics.turns, 6);
  assert.equal(proposal.consultedFeedback.length, 1);
});

test("worker screenshot evidence crosses the artifact boundary as digest-bound raster data", async (t) => {
  const f = fixture(t), png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=", "base64");
  f.args.invoke = async () => {
    mkdirSync(join(f.args.stateDir, "screenshots"), { recursive: true });
    writeFileSync(join(f.args.stateDir, "screenshots", "phone.png"), png);
    return { outcome: { status: "no-change", report: "![Phone](./screenshots/phone.png)" } };
  };
  const proposal = await runWorker(f.args);
  assert.equal(proposal.attachments.length, 1);
  assert.deepEqual(proposal.attachments[0].paths, ["./screenshots/phone.png"]);
  const accepted = readProposal(f.args.resultDir, { operation: f.args.assignment.operation, run: f.run });
  assert.deepEqual(accepted.proposal.attachments, proposal.attachments);
  assert.deepEqual(accepted.attachmentFiles.get(proposal.attachments[0].file), png);
});

test("workers describe available project variable names without putting secret values in prompts or results", async (t) => {
  const f = fixture(t), secret = "private-test-database-password", prompts = [];
  f.args.assignment.config = parseConfig("trusted-users: [ntodd]\nenvironment: {values: {MIX_ENV: test}, worker-secrets: [DATABASE_PASSWORD]}");
  f.args.projectSecrets = { DATABASE_PASSWORD: secret };
  f.args.invoke = async ({ prompt }) => { prompts.push(prompt); return { outcome: { status: "no-change" }, cost: 0.01, turns: 1 }; };
  const proposal = await runWorker(f.args);
  const system = readFileSync(join(f.args.stateDir, "system.md"), "utf8");
  assert.match(system, /DATABASE_PASSWORD/); assert.match(system, /MIX_ENV/);
  assert.equal(JSON.stringify([proposal, prompts, system]).includes(secret), false);
});

test("worker result prose redacts selected project secrets before export", async (t) => {
  const f = fixture(t), secret = "private-test-database-password";
  f.args.assignment.config = parseConfig("trusted-users: [ntodd]\nenvironment: {worker-secrets: [DATABASE_PASSWORD]}");
  f.args.projectSecrets = { DATABASE_PASSWORD: secret };
  f.args.invoke = async () => ({ outcome: { status: "needs-you", reason: `Cannot connect: ${secret}`, report: `Used ${secret}`, tests: [`Failed with ${secret}`, { evidence: secret }] } });
  const proposal = await runWorker(f.args);
  const bytes = readFileSync(join(f.args.resultDir, "proposal.json"), "utf8");
  assert.equal(bytes.includes(secret), false);
  assert.match(proposal.reason, /\[REDACTED\]/);
  assert.match(proposal.report, /\[REDACTED\]/);
  assert.match(JSON.stringify(proposal.tests), /\[REDACTED\]/);
});

test("worker PR prose and thread replies redact selected project secrets", async (t) => {
  for (const mode of ["build", "respond"]) {
    const f = fixture(t), secret = "private-test-database-password", op = f.args.assignment.operation;
    f.args.assignment.config = parseConfig("trusted-users: [ntodd]\nenvironment: {worker-secrets: [DATABASE_PASSWORD]}");
    f.args.projectSecrets = { DATABASE_PASSWORD: secret };
    op.mode = mode;
    if (mode === "build") { op.target.head = null; op.target.number = null; f.fresh.head = null; }
    else op.threadTargets = [{ id: "T1", revision: "f".repeat(64) }];
    f.args.invoke = async ({ phase }) => {
      if (phase === "work") {
        writeFileSync(join(f.root, "code.txt"), "fixed"); f.git(["add", "."]); f.git(["commit", "--quiet", "-m", "Fix"]);
      }
      return { outcome: { status: "ready", title: `Fix ${secret}`, body: `Issue: #7\n${secret}`,
        ...(mode === "respond" ? { replies: [{ thread: "T1", body: `Fixed ${secret}`, resolve: false }] } : {}) } };
    };
    const proposal = await runWorker(f.args);
    const bytes = readFileSync(join(f.args.resultDir, "proposal.json"), "utf8");
    assert.equal(bytes.includes(secret), false);
    assert.match(mode === "build" ? JSON.stringify(proposal.pullRequest) : proposal.replies[0].body, /\[REDACTED\]/);
  }
});

test("a stop between phases prevents further model work or a code proposal", async (t) => {
  const f = fixture(t); let calls = 0;
  f.args.readFresh = async () => ({ ...f.fresh, paused: calls > 0 });
  f.args.invoke = async () => { calls++; return { outcome: { status: "ready" } }; };
  const proposal = await runWorker(f.args);
  assert.equal(calls, 1);
  assert.equal(proposal.outcome, "failed");
  assert.deepEqual(proposal.effects, []);
});

test("needs-you ends the worker with a question instead of waiting for a reply", async (t) => {
  const f = fixture(t); let calls = 0;
  f.args.invoke = async () => { calls++; return { outcome: { status: "needs-you", reason: "Should empty input be rejected or accepted?" } }; };
  const result = await runWorker(f.args);
  assert.equal(calls, 1);
  assert.equal(result.outcome, "needs-you");
  assert.match(result.reason, /empty input/);
});

test("a failed phase exports previously reported usage and no code effects", async (t) => {
  const f = fixture(t);
  f.args.invoke = async ({ phase }) => {
    if (phase === "review") throw new Error("provider failure with private details");
    return { outcome: { status: "ready" }, cost: 0.12, turns: 3 };
  };
  const proposal = await runWorker(f.args);
  assert.equal(proposal.outcome, "failed");
  assert.equal(proposal.metrics.cost, 0.12);
  assert.equal(proposal.metrics.complete, false);
  assert.deepEqual(proposal.effects, []);
  assert.doesNotMatch(JSON.stringify(proposal), /private details/);
});

test("a fresh-read failure preserves the completed phase's usage", async (t) => {
  const f = fixture(t); let reads = 0;
  f.args.readFresh = async () => { if (reads++) throw new Error("offline"); return f.fresh; };
  f.args.invoke = async () => ({ outcome: { status: "ready" }, cost: 0.12, turns: 3 });
  const proposal = await runWorker(f.args);
  assert.equal(proposal.outcome, "failed");
  assert.equal(proposal.metrics.cost, 0.12);
  assert.equal(proposal.metrics.complete, true);
  assert.deepEqual(proposal.effects, []);
});

test("worker environments exclude privileged credentials and Actions tokens", () => {
  const env = workerEnvironment({ PATH: "/bin", HOME: "/home/test", CLAUDE_CODE_OAUTH_TOKEN: "model",
    GITHUB_TOKEN: "job", GH_TOKEN: "write", AGENT_APP_PRIVATE_KEY: "private", AGENT_ATTACH_TOKEN: "pat",
    ACTIONS_RUNTIME_TOKEN: "runtime", FACTORY_APP_KEY: "private", SOME_OTHER_SECRET: "no" }, "read-only");
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "HOME", "PATH"]);
  assert.equal(env.GH_TOKEN, "read-only");
});

test("a rerun with another attempt cannot reuse an operation's claimed ownership", async (t) => {
  const f = fixture(t);
  f.args.run = { id: "100", attempt: 2 };
  await assert.rejects(runWorker(f.args), /does not own/);
});

test("thread replies carry the latest context read between phases and remain artifact proposals", async (t) => {
  const f = fixture(t); let phases = 0;
  f.args.assignment.operation.threadTargets = [{ id: "T1", revision: "a".repeat(64), anchors: [{ sourceId: "review-comment:1", revision: "e".repeat(64) }] }];
  f.args.readFresh = async () => ({ ...f.fresh, feedback: [{ sourceId: "review-comment:1", revision: "e".repeat(64),
    authority: "instruction", thread: "T1", threadRevision: phases ? "b".repeat(64) : "a".repeat(64), body: "Fix this" }] });
  f.args.invoke = async () => { phases++; return { outcome: { status: "no-change", replies: [{ thread: "T1", body: "This case is already covered by the test.", resolve: true }] } }; };
  const result = await runWorker(f.args);
  assert.equal(result.replies[0].revision, "b".repeat(64));
  assert.equal(result.replies[0].resolve, true);
  assert.deepEqual(result.effects, []);
});
