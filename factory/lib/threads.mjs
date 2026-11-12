import { createHash } from "node:crypto";
export const nodeId = (id) => typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\s\x00-\x1f]/.test(id);
export const threadRevision = (facts) => createHash("sha256").update(JSON.stringify(facts.map((f) => [f.sourceId, f.revision])
  .sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
export const threadEffectId = (kind, thread) => `${kind}-${createHash("sha256").update(thread).digest("hex").slice(0, 24)}`;
export function threadTargets(feedback, number) {
  const groups = new Map();
  for (const fact of feedback) if (fact.target === number && fact.thread) {
    if (!groups.has(fact.thread)) groups.set(fact.thread, []);
    groups.get(fact.thread).push(fact);
  }
  return [...groups].flatMap(([id, facts]) => {
    const anchors = facts.filter((f) => f.requiresResponse && ["instruction", "signal"].includes(f.authority));
    return anchors.length ? [{ id, revision: threadRevision(facts), anchors: anchors.map((f) => ({ sourceId: f.sourceId, revision: f.revision })) }] : [];
  });
}
export function replyProposal(reply) {
  if (!reply || Object.keys(reply).some((k) => !["thread", "revision", "body", "resolve"].includes(k))
    || !nodeId(reply.thread) || !/^[a-f\d]{64}$/.test(reply.revision)
    || typeof reply.body !== "string" || !reply.body.trim() || reply.body.length > 60000
    || reply.resolve !== undefined && typeof reply.resolve !== "boolean") throw new Error("Invalid thread reply proposal");
  return { thread: reply.thread, revision: reply.revision, body: reply.body, resolve: reply.resolve === true };
}
