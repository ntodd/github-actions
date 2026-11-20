// GitHub timestamps can have only second precision. Compare database IDs
// numerically within one source kind; lexical sorting puts 100 before 99.
// Across kinds, equal timestamps cannot establish order, so stop wins the tie.
export function compareRequests(a, b) {
  const time = Date.parse(a.at ?? a.createdAt ?? 0) - Date.parse(b.at ?? b.createdAt ?? 0);
  if (Number.isFinite(time) && time) return time;
  const [ak, ai] = String(a.sourceId).split(":"), [bk, bi] = String(b.sourceId).split(":");
  if (ak === bk && /^\d+$/.test(ai) && /^\d+$/.test(bi)) return BigInt(ai) < BigInt(bi) ? -1 : BigInt(ai) > BigInt(bi) ? 1 : 0;
  const action = (v) => v.issueClosureDecision === "stop" ? "stop" : v.action ?? v.command?.action;
  if ((action(a) === "stop") !== (action(b) === "stop")) return action(a) === "stop" ? 1 : -1;
  return ak.localeCompare(bk) || String(a.sourceId).localeCompare(String(b.sourceId));
}
