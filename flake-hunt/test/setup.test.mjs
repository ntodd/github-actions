// run/setup.sh: runs the setup input with the SETUP_SECRETS secret's
// NAME=value lines in its environment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const setup = join(dirname(fileURLToPath(import.meta.url)), "..", "run", "setup.sh");

function runSetup(script, secrets) {
  const cwd = mkdtempSync(join(tmpdir(), "flake-hunt-setup-"));
  const env = { ...process.env, FLAKE_HUNT_SETUP: script };
  delete env.FLAKE_HUNT_SETUP_SECRETS;
  if (secrets !== undefined) env.FLAKE_HUNT_SETUP_SECRETS = secrets;
  const res = spawnSync("bash", [setup], { cwd, encoding: "utf8", env });
  const out = join(cwd, "out");
  return { ...res, out: existsSync(out) ? readFileSync(out, "utf8") : null };
}

test("setup.sh exports each secret to the setup script and masks its value", () => {
  const res = runSetup(
    `printf '%s|%s|%s' "$A" "$B" "\${FLAKE_HUNT_SETUP_SECRETS-gone}" > out`,
    "A=1\n\nB=two=three words\r\n",
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.out, "1|two=three words|gone");
  assert.match(res.stdout, /^::add-mask::1$/m);
  assert.match(res.stdout, /^::add-mask::two=three words$/m);
});

test("setup.sh runs the script without secrets", () => {
  const res = runSetup("echo ok > out");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.out, "ok\n");
});

test("setup.sh rejects a line that isn't NAME=value without printing it", () => {
  const res = runSetup("echo ran > out", "A=1\nhunter2");
  assert.equal(res.status, 1);
  assert.equal(res.out, null);
  assert.match(res.stderr, /Line 2 of SETUP_SECRETS/);
  assert.doesNotMatch(res.stdout + res.stderr, /hunter2/);
});

test("setup.sh stops at the script's first failing command", () => {
  const res = runSetup("false | true; echo ran > out");
  assert.notEqual(res.status, 0);
  assert.equal(res.out, null);
});
