// Effect schemas are deliberately small. Worker output is a proposal; only
// effects confined to the recorded operation may enter the publish journal.
import { nodeId, threadEffectId } from "./threads.mjs";
import { attachmentManifest, attachmentDescriptor, assetUrl, referencedAttachments, screenshotRefs } from "./attachments.mjs";
import { createHash } from "node:crypto";
const SHA = /^[a-f0-9]{40}$/;
export const effectId = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(v);
export function pullRequestText(value) {
  if (!value || typeof value.title !== "string" || !value.title.trim() || value.title.length > 256
    || typeof value.body !== "string" || value.body.length > 60000) throw new Error("A new PR needs a bounded title and body");
  if (/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+|\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+https:\/\/github\.com\/[^\s]+\/issues\/\d+/i.test(value.body)) {
    throw new Error("PR bodies must leave issue completion to the controller; use an Issue reference without a closing keyword");
  }
  return { title: value.title, body: value.body };
}
export function validEffect(effect, op) {
  if (!effectId(effect?.id)) return false;
  if (effect.type === "push") return effect.id === "push" && effect.branch === op.target.branch && effect.expectedHead === op.target.head
    && SHA.test(effect.commit) && effect.baseSha === op.base.sha;
  const attachments = op.effects.filter((e) => e.type === "attachment"), push = op.effects.find((e) => e.type === "push");
  const dependency = attachments.at(-1)?.id ?? push?.id ?? null;
  if (effect.type === "attachment") {
    try { attachmentManifest(attachments.map(attachmentDescriptor)); } catch { return false; }
    try { if (!op.effects.some((e) => ["pull-request", "thread-reply"].includes(e.type) && screenshotRefs(e.body).some((p) => effect.paths.includes(p)))) return false; } catch { return false; }
    const index = attachments.findIndex((a) => a.id === effect.id);
    return index >= 0 && effect.id === `attachment-${effect.digest.slice(7)}` && /^[1-9]\d*$/.test(effect.repositoryId)
      && SHA.test(effect.commit) && effect.commit === (push?.commit ?? op.target.head) && ["build", "respond", "resolve"].includes(op.mode)
      && effect.dependsOn === (attachments[index - 1]?.id ?? push?.id ?? null);
  }
  if (effect.type === "pull-request") {
    try { pullRequestText(effect); } catch { return false; }
    try { referencedAttachments(effect.body, attachments.map(attachmentDescriptor)); } catch { return false; }
    return op.mode === "build" && op.target.number === null && effect.head === op.target.branch
      && effect.base === op.base.ref && SHA.test(effect.commit) && effect.dependsOn === dependency && Boolean(push);
  }
  if (["thread-reply", "thread-resolve"].includes(effect.type)) {
    const target = op.threadTargets?.find((t) => t.id === effect.thread);
    if (!target || !nodeId(effect.thread) || effect.number !== op.target.number || target.revision !== effect.revision
      || effect.commit !== (push?.commit ?? op.target.head) || !["respond", "resolve"].includes(op.mode)) return false;
    if (effect.type === "thread-reply") {
      try { referencedAttachments(effect.body, attachments.map(attachmentDescriptor)); } catch { return false; }
      return effect.id === threadEffectId("reply", effect.thread)
      && typeof effect.body === "string" && effect.body.trim().length > 0 && effect.body.length <= 60000
      && effect.dependsOn === dependency;
    }
    return effect.id === threadEffectId("resolve", effect.thread) && effect.dependsOn === threadEffectId("reply", effect.thread)
      && op.effects.some((e) => e.id === effect.dependsOn && e.type === "thread-reply" && e.thread === effect.thread);
  }
  return false;
}
export function validReceipt(effect, evidence) {
  if (!evidence) return false;
  if (effect.type === "push") return evidence.commit === effect.commit && ["branch-head", "commit-ancestor"].includes(evidence.kind);
  if (effect.type === "attachment") return evidence.kind === "attachment" && evidence.repositoryId === effect.repositoryId
    && evidence.digest === effect.digest && evidence.size === effect.size && assetUrl(evidence.url);
  if (effect.type === "pull-request") return evidence.kind === "pull-request" && evidence.commit === effect.commit
    && Number.isSafeInteger(evidence.number) && evidence.number > 0 && ["open", "closed", "merged"].includes(evidence.state)
    && evidence.head === effect.head && evidence.base === effect.base && (evidence.state !== "merged" || SHA.test(evidence.mergedSha));
  if (effect.type === "thread-reply") return evidence.kind === effect.type && evidence.number === effect.number
    && evidence.thread === effect.thread && nodeId(evidence.id);
  if (effect.type === "thread-resolve") return evidence.kind === effect.type && evidence.number === effect.number
    && evidence.thread === effect.thread && evidence.resolved === true;
  return false;
}
export const effectMarker = (op, effect) => `<!-- factory:effect=${op.id}/${effect.id} -->`;
export const expectedEffectHead = (op, effect) => ["attachment", "pull-request", "thread-reply", "thread-resolve"].includes(effect.type) ? effect.commit : op.target.head;

// A branch receipt proves publication, not inclusion in a merged result.
export function publishedPushes(ledger, key) {
  const item = ledger.items[key];
  return item.attempts.flatMap(({ operation }) => {
    const op = ledger.operations[operation], effect = op.effects.find((e) => e.type === "push" && e.status === "applied");
    const number = op.target.number ?? op.effects.find((e) => e.type === "pull-request" && e.status === "applied")?.receipt.number;
    const pr = item.prs.find((p) => p.number === number);
    return effect && pr ? [{ operation, op, effect, pr, id: effect.requests.at(-1).id, number, commit: effect.commit }] : [];
  });
}

export function landedCommits(ledger, key, extra = []) {
  const rows = publishedPushes(ledger, key), parents = new Map();
  for (const { effect } of rows) {
    const previous = parents.get(effect.commit) ?? [];
    if (effect.expectedHead) previous.push(effect.expectedHead);
    parents.set(effect.commit, previous);
  }
  const known = new Set([...ledger.items[key].prs.filter((p) => p.state === "merged").map((p) => p.mergedSha),
    ...rows.filter((r) => r.effect.landing?.status === "landed").map((r) => r.commit), ...extra]);
  const pending = [...known];
  for (let i = 0; i < pending.length; i++) for (const parent of parents.get(pending[i]) ?? []) {
    if (!known.has(parent)) { known.add(parent); pending.push(parent); }
  }
  return known;
}

export function publicationGaps(ledger, key) {
  const item = ledger.items[key], known = landedCommits(ledger, key), accepted = item.completionAcceptance;
  return publishedPushes(ledger, key).filter((r) => r.pr.required && r.pr.state === "merged" && !known.has(r.commit)).map((r) => ({
    operation: r.operation, request: r.id, number: r.number, commit: r.commit, mergedSha: r.pr.mergedSha,
    reason: r.effect.landing?.reason ?? "unobserved", firstAt: r.effect.landing?.firstAt ?? null,
    accepted: accepted?.revision === item.revision && Number.isSafeInteger(accepted.generation) && r.op.generation <= accepted.generation,
  }));
}
export const publicationDigest = (rows) => createHash("sha256").update(JSON.stringify(rows.map((r) =>
  [r.operation, r.request, r.number, r.commit, r.mergedSha]).sort((a, b) => a[1].localeCompare(b[1])))).digest("hex");
