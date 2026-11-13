import { diagnosticHash, failureKeys } from "./failure-report.mjs";
const sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);

// Producers remain outside the factory. Their registered main-red key names
// the failing default-branch commit. A human can declare that base explicitly
// in an admitted issue's trailing metadata instead of running a producer.
export function repairSpec(authorization, config) {
  if (authorization?.valid !== true) return null;
  const producer = authorization.producer, issue = authorization.issue;
  const human = !producer && config.trustedUsers.includes(issue?.user?.login?.toLowerCase())
    && issue.user.login.toLowerCase() !== config.factoryAppLogin;
  const base = producer?.source === "main-red" ? producer.key
    : human ? /(?:^|\n)<!-- factory:repair-base=([a-f0-9]{40}) -->\s*$/.exec(issue.body ?? "")?.[1] : null;
  return sha(base) ? { baseSha: base, revision: authorization.revision, sourceId: authorization.evidence.sourceId } : null;
}

export function repairRegistration(item, facts) {
  const spec = facts.repairSpec, baseline = facts.repairBaseline;
  if (!spec || facts.authorization?.valid !== true || spec.revision !== facts.authorization.revision
    || spec.sourceId !== item.evidence.sourceId || !baseline?.ancestor || baseline.checks?.headSha !== spec.baseSha || !Array.isArray(baseline.checks.failed)) return null;
  const keys = [...new Set(failureKeys({ failed: baseline.checks.failed.filter((f) => f.completeEvidence) }))].sort();
  return keys.length ? { ...spec, keys, digest: diagnosticHash([spec.baseSha, keys]) } : null;
}

export function validMainRepair(item) {
  const r = item.mainRepair;
  return r === undefined || r && sha(r.baseSha) && typeof r.revision === "string" && /^[a-f0-9]{64}$/.test(r.revision)
    && r.sourceId === item.evidence.sourceId && Array.isArray(r.keys) && r.keys.length > 0 && r.keys.length <= 800
    && new Set(r.keys).size === r.keys.length && r.keys.every((k) => /^[a-f0-9]{64}$/.test(k))
    && r.digest === diagnosticHash([r.baseSha, r.keys]) && Number.isFinite(Date.parse(r.at));
}

export function mainRepairRole(item, facts) {
  const spec = facts.repairSpec, r = item.mainRepair;
  return Boolean(!item.authorizationRevoked && spec && facts.repairBaseline?.ancestor && facts.authorization?.valid === true
    && spec.revision === facts.authorization.revision && spec.sourceId === item.evidence.sourceId
    && (spec.baseSha === facts.main?.sha || r?.revision === facts.authorization.revision
      && failureKeys(facts.main?.checks).some((k) => r.keys.includes(k))));
}

export function repairCandidates(ledger, observations, keys, exclude, currentMainSha) {
  return Object.values(ledger.items).filter((item) => {
    const facts = observations[item.key], r = item.mainRepair;
    const required = item.prs.filter((p) => p.required), final = required.length && required.every((p) => {
      const actual = facts?.prs?.find((pr) => pr.number === p.number);
      return actual?.state === "merged" || actual?.state === "closed" && p.acceptedClosure;
    });
    const currentDeclared = facts?.repairSpec?.baseSha === currentMainSha && facts.repairBaseline?.ancestor === true;
    const registered = r && keys.length > 0 && facts?.repairSpec?.baseSha === r.baseSha
      && facts.repairSpec.sourceId === r.sourceId && r.revision === item.revision && keys.every((key) => r.keys.includes(key));
    return item.key !== exclude && !item.requestOnly && !item.authorizationRevoked && !item.evidence.own && !item.complete && !final && facts?.issueState === "open"
      && facts.authorization?.valid === true && facts.authorization.revision === item.revision
      && (currentDeclared || registered);
  }).map((item) => ({ issue: Number(item.key.split(":")[1]), paused: item.paused, needsYou: Boolean(item.question) }))
    .sort((a, b) => Number(a.paused || a.needsYou) - Number(b.paused || b.needsYou) || a.issue - b.issue);
}
