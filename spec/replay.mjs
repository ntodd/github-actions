// Replay successful Quint state transitions through the real controller reducer.
// The projection compares durable lifecycle state. External GitHub behavior and
// rejected actions are covered separately by protocol/store tests and sandbox CI.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { admit, emptyLedger, evolve, revisionOf } from "../factory/lib/protocol.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "factory-replay-"));
const at = "2026-11-12T12:00:00Z";
const sha = (n) => Number(n).toString(16).padStart(40, "0");
const tooling = "a".repeat(40);
const revision = revisionOf({ title: "Accepted issue" });
const identity = (id) => ({ id: String(id), attempt: 1 });
const provenance = { repositoryId: "42", workflowPath: ".github/workflows/factory.yml", headSha: tooling };

function decode(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  if ("#bigint" in v) { const n = Number(v["#bigint"]); assert(Number.isSafeInteger(n)); return n; }
  if ("#set" in v) return v["#set"].map(decode);
  if ("#tup" in v) return v["#tup"].map(decode);
  if ("#map" in v) return Object.fromEntries(v["#map"].map(([k, value]) => [decode(k), decode(value)]));
  return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, decode(value)]));
}
function run(args) {
  const child = spawnSync(join(root, "node_modules/.bin/quint"), args, { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
}
function replay(file) {
  const raw = JSON.parse(readFileSync(file, "utf8")).states;
  // Quint appends an empty terminal frame for an expected disabled action
  // in `.fail()` scenarios. It is not a successful state transition.
  const states = raw.filter((frame, index) => {
    if (Object.hasOwn(frame, "s")) return true;
    assert.equal(index, raw.length - 1, "Only a terminal failure frame may omit state");
    assert.deepEqual(Object.keys(frame), ["#meta"]);
    return false;
  }).map((frame) => decode(frame.s));
  let ledger = admit(emptyLedger("42"), { key: "issue:7", revision, evidence: { sourceId: "label:1" },
    prs: [1, 2].map((number) => ({ number, required: true, state: "open", mergedSha: null, acceptedClosure: false })) });
  function update(event) { ledger = evolve(ledger, "issue:7", { at, publisher: { id: "900", attempt: 1 }, ...event }); }
  function obs(m) { return { authorization: { valid: true, revision }, open: !m.merged.includes(m.target),
    head: sha(m.heads[m.target]), baseSha: sha(m.main) }; }
  for (let n = 1; n < states.length; n++) {
    const a = states[n - 1], b = states[n], id = `op-${b.op}`;
    const event = (type, extra = {}) => update({ type, operationId: id, ...extra });
    try {
      if (b.op !== a.op) event("reserve", { id, mode: "respond", revision, toolingSha: tooling, configSha: tooling,
        target: { number: b.target, branch: `factory/pr-${b.target}`, head: sha(b.expectedHead) },
        base: { ref: "main", sha: sha(b.expectedBase) } });
      else if (b.owner !== a.owner) event("claim", { run: identity(b.owner), provenance, observation: obs(a) });
      else if (b.generation !== a.generation) event("stop");
      else if (b.paused !== a.paused) event("resume");
      else if (a.live.length > 0 && b.live.length === 0) event("owner-observed", {
        run: identity(b.owner), status: "completed", conclusion: b.artifacts.some(([op, owner]) => op === b.op && owner === b.owner) ? "success" : "failure" });
      else if (b.running.length > a.running.length) event("owner-observed", { run: identity(b.owner), status: "in_progress" });
      else if (a.phase !== b.phase) {
        if (a.phase === "claimed" && b.phase === "result-ready") {
          event("collect-result", {
            artifact: { id: String(200 + b.op), run: identity(b.owner), ...provenance,
              digest: `sha256:${"e".repeat(64)}`, expired: false },
            proposal: { schemaVersion: 1, operationId: id, run: identity(b.owner), outcome: "ready", effects: [
              { id: "push", type: "push", branch: `factory/pr-${b.target}`, expectedHead: sha(b.expectedHead),
                commit: sha(100 + b.op), baseSha: sha(b.expectedBase) },
            ] },
          });
        } else if (b.phase === "publishing") event("authorize-publish", { observation: obs(a) });
        else if (b.phase === "superseded") event("supersede", { observation: obs(a) });
        else if (a.phase === "publishing" && b.phase === "result-ready") event("recover-publish");
        else if (b.phase === "failed") event(a.phase === "claimed" ? "recover-worker" : "result-unavailable", { resultAbsent: true, confirmed: true });
        else if (b.phase === "done") {
          const requestId = ledger.operations[id].effects[0].requests.at(-1).id;
          event("effect-observed", { effectId: "push", requestId, outcome: "applied",
            evidence: { kind: "commit-ancestor", commit: sha(100 + b.op) } });
          event("finish-publish");
        } else assert.fail(`Unmapped phase transition ${a.phase} -> ${b.phase}`);
      } else if (b.requests.length > a.requests.length) event("request-effect", { effectId: "push", observation: obs(a), limit: 1000 });
      else if (b.rejected && !a.rejected) {
        const requestId = ledger.operations[id].effects[0].requests.at(-1).id;
        event("effect-observed", { effectId: "push", requestId, outcome: "rejected", evidence: { kind: "http-rejection", status: 422 } });
      } else if (b.merged.length > a.merged.length) {
        const pr = b.merged.find((p) => !a.merged.includes(p));
        event("pr-observed", { number: pr, state: "merged", mergedSha: sha(a.heads[pr]) });
      } else if (b.complete !== a.complete) event("close-out");

      const item = ledger.items["issue:7"], op = ledger.operations[id];
      assert.equal(item.generation, b.generation);
      assert.equal(item.paused, b.paused);
      assert.equal(item.complete, b.complete);
      assert.equal(item.attempts.length, b.attempts);
      assert.deepEqual(item.prs.filter((p) => p.state === "merged").map((p) => p.number).sort(), [...b.merged].sort());
      if (b.op) {
        assert.equal(item.activeOperation, id);
        assert.equal(op.phase, b.phase);
        assert.equal(op.generation, b.opGeneration);
        assert.equal(op.target.head, sha(b.expectedHead));
        assert.equal(op.base.sha, sha(b.expectedBase));
        assert.equal(op.owner?.id ?? "0", String(b.owner));
      }
    } catch (error) {
      throw new Error(`${file} at transition ${n} (${a.phase} -> ${b.phase}): ${error.message}`, { cause: error });
    }
  }
  return states.length - 1;
}
try {
  run(["test", "spec/factory.qnt", "--backend=rust", "--max-samples=1", "--seed=20261111", `--out-itf=${dir}/{test}-{seq}.json`]);
  for (const profile of ["step", "recoveryStep"]) run(["run", "spec/factory.qnt", "--backend=rust", `--step=${profile}`,
    "--invariant=safety", "--max-samples=25", "--n-traces=25", "--max-steps=100", "--n-threads=1", "--seed=20261111",
    `--out-itf=${dir}/${profile}-{seq}.json`, "--verbosity=0"]);
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  const transitions = files.reduce((sum, file) => sum + replay(join(dir, file)), 0);
  console.log(`Replayed ${files.length} Quint traces and ${transitions} lifecycle transitions through the controller protocol.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
