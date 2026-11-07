// diagnose/diagnose.sh with a stub claude on the PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "diagnose", "diagnose.sh");

// The stub answers with the prompt's first line, edits a tracked file and
// leaves an untracked one, so the test can see the checkout reset. A prompt
// containing FAIL makes it exit 1; one containing EMPTY makes it print nothing.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' | sort >> "$STUB_LOG"
prompt="\${!#}"
echo "edited" >> tracked.txt
echo "scratch" > untracked.txt
case "$prompt" in
  *FAIL*) echo "boom" >&2; exit 1 ;;
  *EMPTY*) exit 0 ;;
esac
echo "Answer for: \${prompt%%$'\\n'*}"
`;

function setup(prompts) {
  const root = mkdtempSync(join(tmpdir(), "flake-hunt-diagnose-"));
  const repo = join(root, "repo");
  const project = join(repo, "apps", "x");
  mkdirSync(project, { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(project, "tracked.txt"), "original\n");
  git("add", ".");
  git("commit", "-qm", "init");
  mkdirSync(join(repo, ".flake-hunt"));
  writeFileSync(join(repo, ".flake-hunt", "keep"), "tools checkout\n");

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), STUB);
  chmodSync(join(bin, "claude"), 0o755);

  const promptDir = join(root, "prompts");
  mkdirSync(promptDir);
  for (const [id, text] of Object.entries(prompts)) writeFileSync(join(promptDir, `${id}.md`), text);
  return { root, repo, project, bin, promptDir, out: join(root, "out"), log: join(root, "stub.log") };
}

function run(s, env = {}) {
  return spawnSync("bash", [script, s.promptDir, s.out], {
    cwd: s.project,
    encoding: "utf8",
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, STUB_LOG: s.log, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "oauth", ...env },
  });
}

test("diagnose.sh writes one answer per prompt and resets the checkout between them", () => {
  const s = setup({ d1: "First flake\nmore", d2: "Second flake" });
  const res = run(s);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(readdirSync(s.out).sort(), ["d1.md", "d2.md"]);
  assert.equal(readFileSync(join(s.out, "d1.md"), "utf8"), "Answer for: First flake\n");
  assert.equal(readFileSync(join(s.project, "tracked.txt"), "utf8"), "original\n");
  assert.ok(!existsSync(join(s.project, "untracked.txt")));
  assert.ok(existsSync(join(s.repo, ".flake-hunt", "keep")));

  const log = readFileSync(s.log, "utf8");
  assert.match(log, /-p --dangerously-skip-permissions --max-turns 60/);
  assert.match(log, /CLAUDE_CODE_OAUTH_TOKEN=oauth/);
  assert.doesNotMatch(log, /ANTHROPIC_API_KEY=/, "an empty API key must not be passed on");
});

test("diagnose.sh passes the model, and leaves no file for a failed or empty answer", () => {
  const s = setup({ d1: "FAIL please", d2: "EMPTY please", d3: "ok" });
  const res = run(s, { FLAKE_HUNT_MODEL: "claude-opus-5-5" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(readdirSync(s.out), ["d3.md"]);
  assert.match(res.stdout, /::warning::Diagnosis d1 failed/);
  assert.match(res.stdout, /::warning::Diagnosis d2 failed/);
  assert.match(readFileSync(s.log, "utf8"), /--model claude-opus-5-5/);
});
