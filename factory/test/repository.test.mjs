import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRepository } from "../lib/reconcile.mjs";
import { admit, evolve, revisionOf } from "../lib/protocol.mjs";
import { parseConfig } from "../lib/config.mjs";
import { initial, at, A, B, C, revision } from "./fixtures.mjs";
const config = parseConfig("trusted-users: [ntodd]");
const ownFact = (number = 9) => ({ authorization: { valid: true, revision }, issueState: "open", prs: [
  { number, state: "open", mergeable: "MERGEABLE", headSha: B, baseSha: A, behind: true, autoMerge: true, approvalRequired: false,
    checks: { state: "success", headSha: B, failed: [] } },
] });
function two() {
  return admit(initial(), { key: "issue:8", revision, evidence: { sourceId: "label:2" }, prs: [{ number: 11, required: true, state: "open", acceptedClosure: false, mergedSha: null }] });
}

test("only one PR is selected for update across a repository pass", () => {
  const result = decideRepository(two(), { "issue:7": ownFact(), "issue:8": ownFact(11) }, config, { now: at });
  assert.equal(result.state.integration.item, "issue:7");
  assert.equal(result.plans[0].action.mode, "update");
  assert.equal(result.plans[1].status.wait.kind, "integration");
});

test("an accepted main repair issue has priority ahead of ordinary issue work", () => {
  const s = two();
  s.items["issue:8"].evidence.producer = { source: "main-red", key: "compile" };
  const result = decideRepository(s, { "issue:7": ownFact(), "issue:8": ownFact(11) }, config, { now: at });
  assert.equal(result.plans[0].key, "issue:8");
  assert.equal(result.state.integration.item, "issue:8");
});

test("an expired or human-blocked integration selection releases other PRs", () => {
  let s = evolve(two(), "issue:7", { type: "select-integration", number: 9, at, deadline: "2026-11-12T12:05:00Z" });
  const blocked = ownFact(); blocked.prs[0].behind = false; blocked.prs[0].approvalRequired = true;
  let result = decideRepository(s, { "issue:7": blocked, "issue:8": ownFact(11) }, config, { now: at });
  assert.equal(result.state.integration.item, "issue:8");
  s = evolve(s, "issue:7", { type: "stop" });
  result = decideRepository(s, { "issue:7": blocked, "issue:8": ownFact(11) }, config, { now: "2026-11-12T12:06:00Z" });
  assert.equal(result.state.integration.item, "issue:8");
});
