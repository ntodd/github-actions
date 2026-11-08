// Who may start a run, and at what effort.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function parseList(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const login = (user) => String(user?.login ?? "").toLowerCase();

// flake-hunt files its issues with the job's GITHUB_TOKEN, as
// github-actions[bot], and starts a run on each with a workflow_dispatch.
// Only workflows in the repo can write as github-actions[bot]. Claude
// can't: its writes are the App's.
export const FLAKE_HUNT_BOT = "github-actions[bot]";
const FLAKE_HUNT_MARKER = /<!-- flake-hunt:\S+ -->/;

export function isFlakeHuntIssue(issue) {
  return login(issue?.user) === FLAKE_HUNT_BOT && FLAKE_HUNT_MARKER.test(issue?.body ?? "");
}

// A run starts when a trusted user adds the label to an open issue, or
// dispatches the workflow on an open issue that has it. Either way a
// trusted user or flake-hunt must have written the issue. flake-hunt may
// dispatch too, but only on its own issues. Everything else is skipped
// with a reason.
export function checkTrigger(event, { label, trustedUsers, eventName = "issues", issue = event.issue }) {
  const trusted = new Set(trustedUsers.map((u) => u.toLowerCase()));
  const no = (reason) => ({ run: false, reason });
  if (trusted.size === 0) return no("no trusted-users are set");
  const dispatched = eventName === "workflow_dispatch";
  if (dispatched) {
    if (!issue) return no("no issue was given");
    if (issue.pull_request) return no(`#${issue.number} is a pull request`);
    if (!(issue.labels ?? []).some((l) => (l.name ?? l) === label)) return no(`#${issue.number} isn't labeled ${label}`);
  } else {
    if (event.action !== "labeled" || !issue) return no("this isn't a labeled issue");
    if (event.label?.name !== label) return no(`the label added was ${event.label?.name}, not ${label}`);
  }
  if (issue.state !== "open") return no(`#${issue.number} isn't open`);
  const flake = isFlakeHuntIssue(issue);
  const sender = login(event.sender);
  if (dispatched && sender === FLAKE_HUNT_BOT && !trusted.has(sender)) {
    if (!flake) return no(`${FLAKE_HUNT_BOT} started the run, and it may only start runs on flake-hunt's issues`);
  } else if (!trusted.has(sender)) {
    return no(`${event.sender?.login} ${dispatched ? "started the run" : "added the label"} and isn't trusted`);
  }
  if (!trusted.has(login(issue.user)) && !flake) return no(`${issue.user?.login} wrote the issue and isn't trusted`);
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
