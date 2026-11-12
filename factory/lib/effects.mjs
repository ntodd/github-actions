// Effect schemas are deliberately small. Worker output is a proposal; only
// effects confined to the recorded operation may enter the publish journal.
import { nodeId, threadEffectId } from "./threads.mjs";
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
  if (effect.type === "pull-request") {
    try { pullRequestText(effect); } catch { return false; }
    return op.mode === "build" && op.target.number === null && effect.head === op.target.branch
      && effect.base === op.base.ref && SHA.test(effect.commit) && effect.dependsOn === "push";
  }
  if (["thread-reply", "thread-resolve"].includes(effect.type)) {
    const target = op.threadTargets?.find((t) => t.id === effect.thread), push = op.effects.find((e) => e.type === "push");
    if (!target || !nodeId(effect.thread) || effect.number !== op.target.number || target.revision !== effect.revision
      || effect.commit !== (push?.commit ?? op.target.head) || !["respond", "resolve"].includes(op.mode)) return false;
    if (effect.type === "thread-reply") return effect.id === threadEffectId("reply", effect.thread)
      && typeof effect.body === "string" && effect.body.trim().length > 0 && effect.body.length <= 60000
      && effect.dependsOn === (push?.id ?? null);
    return effect.id === threadEffectId("resolve", effect.thread) && effect.dependsOn === threadEffectId("reply", effect.thread)
      && op.effects.some((e) => e.id === effect.dependsOn && e.type === "thread-reply" && e.thread === effect.thread);
  }
  return false;
}
export function validReceipt(effect, evidence) {
  if (!evidence) return false;
  if (effect.type === "push") return evidence.commit === effect.commit && ["branch-head", "commit-ancestor"].includes(evidence.kind);
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
export const expectedEffectHead = (op, effect) => ["pull-request", "thread-reply", "thread-resolve"].includes(effect.type) ? effect.commit : op.target.head;
