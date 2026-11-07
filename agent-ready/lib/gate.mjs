// Who may start a run, and at what effort.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function parseList(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const login = (user) => String(user?.login ?? "").toLowerCase();

// A run starts only when a trusted user adds the label to an open issue
// that a trusted user wrote. Everything else is skipped with a reason.
export function checkTrigger(event, { label, trustedUsers }) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  const no = (reason) => ({ run: false, reason });
  if (trusted.size === 0) return no("no trusted-users are set");
  if (event.action !== "labeled" || !event.issue) return no("this isn't a labeled issue");
  if (event.label?.name !== label) return no(`the label added was ${event.label?.name}, not ${label}`);
  if (event.issue.state !== "open") return no(`issue #${event.issue.number} isn't open`);
  if (!trusted.has(login(event.sender))) return no(`${event.sender?.login} added the label and isn't trusted`);
  if (!trusted.has(login(event.issue.user))) return no(`${event.issue.user?.login} wrote the issue and isn't trusted`);
  return { run: true };
}

export function trustedComments(comments, trustedUsers) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  return comments.filter((c) => trusted.has(login(c.user)));
}

// An effort:<level> label wins (the highest, if there are several). Then
// the last /effort <level> in a trusted comment. Then the default.
export function resolveEffort({ labels, comments, trustedUsers, defaultEffort }) {
  const fromLabels = labels
    .map((l) => /^effort:\s*(\w+)$/i.exec(l.name ?? "")?.[1]?.toLowerCase())
    .filter((e) => EFFORTS.includes(e));
  if (fromLabels.length) return fromLabels.reduce((a, b) => (EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a));

  let fromComment;
  for (const c of trustedComments(comments, trustedUsers)) {
    for (const m of String(c.body ?? "").matchAll(/^\/effort\s+(\w+)/gim)) {
      if (EFFORTS.includes(m[1].toLowerCase())) fromComment = m[1].toLowerCase();
    }
  }
  return fromComment ?? defaultEffort;
}
