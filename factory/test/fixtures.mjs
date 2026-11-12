import { admit, emptyLedger, evolve, revisionOf } from "../lib/protocol.mjs";
export const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
export const at = "2026-11-12T12:00:00Z";
export const defaultLanding = (commit) => ({ status: "landed", commit, at, checks: 1, source: "main", ref: "main", baseRef: "main", destination: commit, method: "base" });
export const run = { id: "100", attempt: 1 };
export const provenance = { repositoryId: "42", workflowPath: ".github/workflows/factory.yml", headSha: A };
export const revision = revisionOf({ title: "Fix it", body: "Accepted task" });
export const observation = { authorization: { valid: true, revision }, head: B, baseSha: A, open: true };
export const reserve = (id = "op-1", extra = {}) => ({ type: "reserve", id, mode: "respond", revision,
  target: { number: 9, branch: "factory/issue-7", head: B }, base: { ref: "main", sha: A },
  toolingSha: A, configSha: A, at, ...extra });
export const artifact = { id: "200", run, ...provenance, digest: `sha256:${"e".repeat(64)}`, expired: false };
export const proposal = { schemaVersion: 1, operationId: "op-1", run, outcome: "ready", effects: [
  { id: "push", type: "push", branch: "factory/issue-7", expectedHead: B, commit: C, baseSha: A },
] };
export function initial() {
  return admit(emptyLedger("42"), { key: "issue:7", revision, evidence: { sourceId: "label:123" },
    prs: [9, 10].map((number) => ({ number, required: true, state: "open", mergedSha: null, acceptedClosure: false })) });
}
export const step = (s, event) => evolve(s, "issue:7", { operationId: "op-1", at, publisher: { id: "900", attempt: 1 }, ...event });
export const operation = (s) => s.operations[s.items["issue:7"].activeOperation];
export function claimed() {
  return step(step(initial(), reserve()), { type: "claim", run, provenance, observation });
}
export function ready() {
  let s = step(claimed(), { type: "owner-observed", run, status: "completed", conclusion: "success" });
  return step(s, { type: "collect-result", proposal, artifact });
}
export const publishing = () => step(ready(), { type: "authorize-publish", observation });
export const pending = () => step(publishing(), { type: "request-effect", effectId: "push", observation });
