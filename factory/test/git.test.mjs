import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitCommand, cleanGitWriter, repositoryUrl } from "../lib/git.mjs";
import { exportProposal, readProposal } from "../lib/artifact.mjs";
import { cleanUpdate } from "../lib/worker.mjs";
const text = (r) => r.stdout.toString("utf8").trim();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-git-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "worker"), remote = join(root, "remote.git"), artifact = join(root, "artifact");
  mkdirSync(repo);
  const git = (args) => gitCommand(repo, args);
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "code.txt"), "original\n");
  git(["add", "."]); git(["commit", "--quiet", "-m", "Base"]);
  const base = text(git(["rev-parse", "HEAD"]));
  git(["init", "--bare", "--quiet", remote]);
  git(["push", "--quiet", remote, "HEAD:refs/heads/main", "HEAD:refs/heads/factory/issue-7"]);
  const op = { id: "op-1", mode: "respond", target: { number: 9, branch: "factory/issue-7", head: base }, base: { ref: "main", sha: base } };
  const commit = (path = "code.txt", content = "fixed\n") => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content); git(["add", "."]); git(["commit", "--quiet", "-m", "Fix"]);
    return text(git(["rev-parse", "HEAD"]));
  };
  const exportIt = () => exportProposal({ cwd: repo, directory: artifact, operation: op, run: { id: "100", attempt: 1 }, outcome: { status: "ready", tests: ["unit tests"] } });
  const writer = () => { const w = cleanGitWriter({ remote, allowLocal: true, bundleFile: join(artifact, "proposal.bundle") }); t.after(() => w.dispose()); return w; };
  return { root, repo, remote, artifact, git, op, base, commit, exportIt, writer };
}

test("a worker bundle is validated in a clean bare repository and only appends its target branch", async (t) => {
  const f = fixture(t), commit = f.commit(), proposal = f.exportIt(), writer = f.writer();
  const read = readProposal(f.artifact, { operation: f.op, run: { id: "100", attempt: 1 } });
  assert.equal(read.proposal.effects[0].commit, commit);
  await writer.validate(proposal.effects[0], f.op);
  assert.equal((await writer.apply(proposal.effects[0], f.op)).outcome, "applied");
  assert.equal(text(f.git(["ls-remote", "--refs", f.remote, "refs/heads/factory/issue-7"])).split("\t")[0], commit);
  assert.equal(text(f.git(["ls-remote", "--refs", f.remote, "refs/heads/main"])).split("\t")[0], f.base);
  assert.equal((await writer.inspect(proposal.effects[0])).outcome, "applied");
});

test("a human push after validation is protected by the expected-head lease", async (t) => {
  const f = fixture(t), proposed = f.commit(), proposal = f.exportIt(), writer = f.writer();
  await writer.validate(proposal.effects[0], f.op);
  // Even an intermediate ancestor of the candidate must not silently replace
  // the original expected head. Here a different human commit wins first.
  f.git(["reset", "--hard", f.base]);
  const human = f.commit("human.txt", "human work\n");
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/factory/issue-7"]);
  assert.equal((await writer.apply(proposal.effects[0], f.op)).outcome, "rejected");
  assert.equal(text(f.git(["ls-remote", "--refs", f.remote, "refs/heads/factory/issue-7"])).split("\t")[0], human);
  assert.notEqual(human, proposed);
});

test("rewritten ancestry, a wrong advertised commit and workflow changes are rejected", async (t) => {
  const f = fixture(t);
  f.commit(".github/workflows/unsafe.yml", "name: unsafe\n");
  const proposal = f.exportIt(), writer = f.writer();
  await assert.rejects(writer.validate(proposal.effects[0], f.op), /workflow/);
  await assert.rejects(writer.validate({ ...proposal.effects[0], commit: "f".repeat(40) }, f.op), /advertise/);
  await assert.rejects(writer.validate({ ...proposal.effects[0], branch: "main" }, f.op), /recorded/);
});

test("an applied commit is recovered after a later human append", async (t) => {
  const f = fixture(t); f.commit(); const proposal = f.exportIt(), writer = f.writer();
  await writer.apply(proposal.effects[0], f.op);
  f.commit("human.txt", "later work\n");
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/factory/issue-7"]);
  assert.equal((await writer.inspect(proposal.effects[0])).evidence.kind, "commit-ancestor");
});

test("bundle corruption, substituted attempts and symlinks cannot cross the artifact boundary", (t) => {
  const f = fixture(t); f.commit(); f.exportIt();
  assert.throws(() => readProposal(f.artifact, { operation: f.op, run: { id: "100", attempt: 2 } }), /belong/);
  appendFileSync(join(f.artifact, "proposal.bundle"), "tampered");
  assert.throws(() => readProposal(f.artifact, { operation: f.op, run: { id: "100", attempt: 1 } }), /digest/);
  rmSync(join(f.artifact, "proposal.json"));
  symlinkSync(join(f.repo, "code.txt"), join(f.artifact, "proposal.json"));
  assert.throws(() => readProposal(f.artifact, { operation: f.op, run: { id: "100", attempt: 1 } }));
});

test("dirty worker trees cannot silently lose uncommitted changes", (t) => {
  const f = fixture(t); f.commit(); writeFileSync(join(f.repo, "forgotten.txt"), "not committed");
  assert.throws(() => f.exportIt(), /commit/);
});

test("repository URLs cannot smuggle credentials, queries or arbitrary protocols", () => {
  assert.equal(repositoryUrl("ntodd/repo"), "https://github.com/ntodd/repo.git");
  for (const server of ["http://github.com", "https://user:secret@github.com", "https://github.com/?x=y", "file:///tmp/repo"]) assert.throws(() => repositoryUrl("ntodd/repo", server));
});

test("a proposal cannot attach an unrelated history in place of the recorded head", async (t) => {
  const f = fixture(t); f.commit(); const proposal = f.exportIt();
  f.git(["checkout", "--orphan", "unrelated"]);
  f.git(["commit", "--quiet", "-m", "Unrelated root"]);
  const unrelated = text(f.git(["rev-parse", "HEAD"]));
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/unrelated"]);
  const op = { ...f.op, target: { ...f.op.target, head: unrelated } };
  await assert.rejects(f.writer().validate({ ...proposal.effects[0], expectedHead: unrelated }, op), /extend/);
});

test("object size limits apply before a proposal can be pushed", async (t) => {
  const f = fixture(t); f.commit("large.txt", "a".repeat(1000)); const proposal = f.exportIt();
  const writer = cleanGitWriter({ remote: f.remote, allowLocal: true, bundleFile: join(f.artifact, "proposal.bundle"), limits: { maxBlobBytes: 100 } });
  t.after(() => writer.dispose());
  await assert.rejects(writer.validate(proposal.effects[0], f.op), /limits/);
});

test("clean update merges two recorded histories in a fresh bare repository without executing project hooks", (t) => {
  const f = fixture(t), prHead = f.commit("pr.txt", "PR change\n");
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/factory/issue-7"]);
  f.git(["reset", "--hard", f.base]);
  const base = f.commit("main.txt", "new main\n");
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/main"]);
  writeFileSync(join(f.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const op = { ...f.op, mode: "update", target: { ...f.op.target, head: prHead }, base: { ref: "main", sha: base } };
  const clean = f.writer(); clean.seed(op);
  const result = cleanUpdate({ cwd: clean.directory, operation: op, directory: f.artifact,
    run: { id: "100", attempt: 1 }, author: { name: "Factory", email: "factory@example.com" } });
  assert.equal(result.outcome, "ready");
  const parents = text(gitCommand(clean.directory, ["rev-list", "--parents", "-n", "1", result.commit])).split(" ");
  assert.deepEqual(parents, [result.commit, prHead, base]);
  assert.equal(text(gitCommand(clean.directory, ["show", `${result.commit}:pr.txt`])), "PR change");
  assert.equal(text(gitCommand(clean.directory, ["show", `${result.commit}:main.txt`])), "new main");
  assert.throws(() => cleanUpdate({ cwd: f.repo, operation: op, directory: f.artifact, author: {} }), /bare/);
});

test("clean update returns conflicts or no-change without creating a misleading integration bundle", (t) => {
  const f = fixture(t), prHead = f.commit("code.txt", "PR version\n");
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/factory/issue-7"]);
  f.git(["reset", "--hard", f.base]);
  const base = f.commit("code.txt", "main version\n");
  f.git(["push", "--quiet", f.remote, "HEAD:refs/heads/main"]);
  const op = { ...f.op, mode: "update", target: { ...f.op.target, head: prHead }, base: { ref: "main", sha: base } };
  const clean = f.writer(); clean.seed(op);
  const args = { cwd: clean.directory, operation: op, directory: f.artifact, author: { name: "Factory", email: "factory@example.com" } };
  assert.equal(cleanUpdate(args).outcome, "conflict");
  assert.equal(cleanUpdate({ ...args, operation: { ...op, base: { ref: "main", sha: f.base } } }).outcome, "no-change");
});
