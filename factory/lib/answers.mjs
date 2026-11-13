// A numbered answer applies only to the question the controller actually asked.
// Explicit identifiers remain usable from any GitHub client without a router.
export function answerText(command) {
  let text = command.text.trim();
  if (command.routed && command.routedHandle) {
    const handle = command.routedHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(^|[^\\w@])@${handle}(?![\\w-])`, "ig"), "$1").trim();
  }
  text = text.replace(/^[:,]\s*/, "").replace(/[.!]\s*$/, "").trim();
  const choice = /^(?:(?:go with|use|choose|pick|select|take|option)\s+(?:option\s+)?)?([12])$/i.exec(text);
  const named = /^(?:(?:go with|use|choose|pick|select|take)\s+)?(continue|stop|accept-completion|accept-closure\s+#?[1-9]\d*)$/i.exec(text);
  return choice?.[1] ?? named?.[1].toLowerCase() ?? text;
}

export function closureAnswer(command, question, revision) {
  if (command?.action !== "answer") return null;
  const text = answerText(command).toLowerCase();
  const explicit = /^accept-closure\s+#?([1-9]\d*)$/.exec(text);
  if (explicit) {
    const number = Number(explicit[1]);
    return Number.isSafeInteger(number) ? number : null;
  }
  return text === "1" && question?.kind === "pr-closure" && question.revision === revision
    && Number.isFinite(Date.parse(question.at)) && Date.parse(command.at) >= Date.parse(question.at)
    ? question.number : null;
}

export function issueClosureAnswer(command, question, revision) {
  if (command?.action !== "answer" || question?.kind !== "issue-closure" || question.revision !== revision
    || !Number.isFinite(Date.parse(question.at)) || !Number.isFinite(Date.parse(command.at ?? command.createdAt))
    || Date.parse(command.at ?? command.createdAt) < Date.parse(question.at)) return null;
  const text = answerText(command).toLowerCase();
  return ["1", "continue"].includes(text) ? "continue" : ["2", "stop"].includes(text) ? "stop" : null;
}

export function issueClosureChoice(command, item) {
  const answer = issueClosureAnswer(command, item.question, item.revision);
  if (answer) return answer;
  const c = item.continuation;
  // A correction posted while the original reopen is still pending can stop
  // that continuation. It cannot replace an uncertain reopen with a new one.
  return !item.question && c?.phase === "requested" && issueClosureAnswer(command,
    { kind: "issue-closure", revision: c.revision, at: c.createdAt }, item.revision) === "stop" ? "stop" : null;
}
