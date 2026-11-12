// Admission and feedback classification operate on facts read afresh from the
// API. Event payloads, labels written by the App, and marker text grant no trust.
import { createHash } from "node:crypto";
import { revisionOf } from "./protocol.mjs";
import { threadRevision } from "./threads.mjs";
import { compareRequests } from "./ordering.mjs";
const id = (v) => (typeof v === "string" && /^[1-9]\d*$/.test(v)) || (Number.isSafeInteger(v) && v > 0) ? String(v) : null;
const login = (v) => String(typeof v === "string" ? v : v?.login ?? "").toLowerCase();
const actor = (fact) => login(fact.author ?? fact.user ?? fact.actor);
const member = (users, user) => users.some((u) => u.toLowerCase() === login(user));
const trustedHuman = (config, user) => login(user) !== config.factoryAppLogin && member(config.trustedUsers, user);
export const ACTIONS = new Set(["answer", "respond", "resolve", "update", "build", "restart", "retry", "stop", "effort", "status", "clarify"]);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function unedited(fact) {
  if (Object.hasOwn(fact, "lastEditedAt")) return fact.lastEditedAt === null;
  return typeof fact.created_at === "string" && fact.created_at === fact.updated_at;
}

export function parseCommand(text, handle) {
  const body = String(text ?? "").trim();
  if (body === "/resolve") return { action: "resolve", text: "", exact: true };
  const effort = /^\/effort\s+(\S+)\s*$/i.exec(body);
  if (effort) return EFFORTS.includes(effort[1].toLowerCase())
    ? { action: "effort", effort: effort[1].toLowerCase(), text: "", exact: true }
    : { action: "clarify", text: "Unknown effort level", exact: true };
  const command = /^\/agent(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(body);
  if (command) {
    const action = command[1]?.toLowerCase();
    if (!ACTIONS.has(action)) return { action: "clarify", text: "Unknown agent action", exact: true };
    const text = command[2]?.trim() ?? "";
    if (action === "effort") return EFFORTS.includes(text.toLowerCase())
      ? { action, effort: text.toLowerCase(), text: "", exact: true }
      : { action: "clarify", text: "Unknown effort level", exact: true };
    return { action, text, exact: true };
  }
  // A mention requests routing; it does not itself authorize an arbitrary mode.
  const escaped = String(handle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, "i").test(body)) return { action: "route", text: body, exact: false };
  return null;
}

export function sourceMarker(body) {
  const modern = /<!-- agent-ready:source=([a-z][a-z0-9-]*) key=([^\s<>]{1,256}) -->\s*$/.exec(body ?? "");
  if (modern) return { source: modern[1], key: modern[2] };
  const legacy = /<!-- flake-hunt:([^\s<>]{1,256}) -->\s*$/.exec(body ?? "");
  return legacy ? { source: "flake-hunt", key: legacy[1], legacy: true } : null;
}

export function classifyText(fact, kind, config, { target, thread, state, head } = {}) {
  const sourceId = id(fact.id ?? fact.databaseId);
  if (!sourceId) throw new Error("API text fact is missing a stable numeric ID");
  const body = fact.body ?? "";
  if (typeof body !== "string") throw new Error("Malformed text from GitHub");
  const author = actor(fact);
  const trustedEdits = Array.isArray(fact.editors) && fact.editors.length > 0 && fact.editors.every((editor) => trustedHuman(config, editor));
  const trusted = trustedHuman(config, author) && (unedited(fact) || trustedEdits);
  const bot = author !== config.factoryAppLogin && config.reviewBots.some((b) => b === author);
  const revision = fingerprint([body, state ?? fact.state ?? null, head ?? fact.commit_id ?? null,
    fact.lastEditedAt ?? fact.updated_at ?? fact.updatedAt ?? fact.created_at ?? null]);
  return { sourceId: `${kind}:${sourceId}`, revision, body, author, target, thread,
    state: state ?? fact.state ?? null, head: head ?? fact.commit_id ?? null,
    createdAt: fact.createdAt ?? fact.created_at ?? fact.submitted_at,
    trustedAuthor: trustedHuman(config, author), edited: !unedited(fact),
    authority: trusted ? "instruction" : bot ? "signal" : "data",
    command: trusted && unedited(fact) && kind !== "review" ? parseCommand(body, config.handle) : null };
}

export function classifyLabel(event, config, target) {
  if (event.event !== "labeled" || !trustedHuman(config, event.actor)) return null;
  const name = event.label?.name ?? event.label;
  const effort = /^effort:(low|medium|high|xhigh|max)$/.exec(name ?? "");
  if (name !== "agent-ready" && !effort) return null;
  if (!id(event.id) || !Number.isFinite(Date.parse(event.created_at))) throw new Error("Label history is missing its stable identity or timestamp");
  return { sourceId: `label:${id(event.id)}`, revision: fingerprint([name, actor(event), event.created_at]),
    body: `Trusted label: ${name}`, author: actor(event), authority: "instruction", target,
    createdAt: event.created_at, command: effort ? { action: "effort", effort: effort[1], text: "" } : { action: "build", text: "" } };
}

export function authorizeIssue({ issue, editors, events, comments = [], config, evidence = null, commandId = null, allowClosed = false, allowRequest = false }) {
  const no = (reason) => ({ valid: false, reason });
  if (!issue || issue.pull_request || !(issue.state === "open" || allowClosed && evidence?.sourceId && issue.state === "closed") || !id(issue.number)) return no("The target is not an open issue");
  const author = actor(issue);
  const marker = sourceMarker(issue.body);
  const producer = author === "github-actions[bot]" && marker && config.producers.includes(marker.source) ? marker : null;
  if (!trustedHuman(config, author) && !producer) return no("The issue author is not trusted or an allowed producer");
  if (!Array.isArray(editors)) return no("Issue edit history is unavailable");
  if (editors.some((e) => !trustedHuman(config, e) && !(producer && login(e) === "github-actions[bot]"))) return no("An untrusted actor edited the issue");
  const revision = revisionOf(issue);
  const sourceId = commandId ?? evidence?.sourceId;
  if (sourceId?.startsWith("issue-comment:")) {
    const found = comments.find((c) => `issue-comment:${id(c.id)}` === sourceId);
    if (!found) return no("The authorizing command no longer exists on this issue");
    const fact = classifyText(found, "issue-comment", config, { target: issue.number });
    if (fact.authority !== "instruction" || !fact.command) return no("The command cannot authorize new issue work");
    if (evidence?.revision && evidence.revision !== fact.revision) return no("The authorizing command changed");
    const source = { sourceId, revision: fact.revision, actor: fact.author, at: fact.createdAt };
    const routed = fact.command.action === "route" && evidence?.kind === "routed-command" && ["build", "restart"].includes(evidence.action);
    if (!routed && !["build", "restart"].includes(fact.command.action)) {
      if (allowRequest || evidence?.kind === "request") return { valid: false, requestValid: true,
        reason: "The request has not authorized coding", revision, producer, evidence: { kind: "request", ...source } };
      return no("The command cannot authorize new issue work");
    }
    return { valid: true, revision, producer, evidence: { kind: routed ? "routed-command" : "command", ...source,
      ...(routed ? { action: evidence.action } : {}) } };
  }
  if (!Array.isArray(events)) return no("Label history is unavailable");
  const labels = events.filter((e) => e.event === "labeled" && (e.label?.name ?? e.label) === "agent-ready");
  const labeled = sourceId ? labels.find((e) => `label:${id(e.id)}` === sourceId) : labels.at(-1);
  if (!labeled || !id(labeled.id)) return no("No authorizing agent-ready label event exists");
  const labeler = actor(labeled);
  if (!trustedHuman(config, labeler) && !(producer && labeler === "github-actions[bot]")) return no("The label was not authorized by a trusted user or this producer");
  if (!sourceId && !(issue.labels ?? []).some((l) => (l.name ?? l) === "agent-ready")) return no("The issue is not queued for admission");
  const labelRevision = fingerprint(["agent-ready", labeler, labeled.created_at]);
  if (evidence?.revision && evidence.revision !== labelRevision) return no("The authorizing label changed");
  return { valid: true, revision, producer, evidence: { kind: "label", sourceId: `label:${id(labeled.id)}`,
    revision: labelRevision, actor: labeler, at: labeled.created_at } };
}

export async function inspectIssue(api, number, config, options = {}) {
  const [issue, editors, events, comments] = await Promise.all([
    api.issue(number), api.editors(number, "issue"), api.events(number), api.comments(number),
  ]);
  return { ...authorizeIssue({ issue, editors, events, comments, config, ...options }), issue, comments };
}

function prCommandFacts(pr, comments, threads, config) {
  return [...comments.map((c) => classifyText(c, "issue-comment", config, { target: pr.number })),
    ...threads.flatMap((t) => t.comments.map((c) => classifyText(c, "review-comment", config, { target: pr.number, thread: t.id })))].sort(compareRequests);
}

export function authorizeOwnPr({ pr, editors, comments = [], threads = [], commandId, evidence, config, repo, defaultBranch, allowClosed = false, allowRequest = false }) {
  const no = (reason) => ({ valid: false, reason });
  if (!pr || !(pr.state === "open" || allowClosed && evidence?.sourceId && pr.state === "closed") || pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
    || pr.base?.ref !== defaultBranch) return no("Only open same-repository PRs into the default branch are supported");
  if (!trustedHuman(config, pr.user) || !Array.isArray(editors) || editors.some((e) => !trustedHuman(config, e))) return no("PR authorship or edits are not trusted");
  const sourceId = commandId ?? evidence?.sourceId;
  const fact = prCommandFacts(pr, comments, threads, config).find((f) => f.sourceId === sourceId);
  if (!fact) return no("An explicit command on this PR is required");
  if (fact.authority !== "instruction" || !fact.command) return no("The authorizing PR command is not valid");
  if (evidence?.revision && evidence.revision !== fact.revision) return no("The authorizing PR command changed");
  const source = { sourceId, revision: fact.revision, actor: fact.author, own: true, at: fact.createdAt };
  const routed = fact.command.action === "route" && evidence?.kind === "routed-command" && ["resolve", "update"].includes(evidence.action);
  if (!routed && !["resolve", "update"].includes(fact.command.action)) {
    if (allowRequest || evidence?.kind === "request") return { valid: false, requestValid: true,
      reason: "The request has not authorized maintenance", revision: revisionOf(pr), evidence: { kind: "request", ...source } };
    return no("The authorizing PR command is not valid");
  }
  return { valid: true, revision: revisionOf(pr), evidence: { kind: routed ? "routed-command" : "command", ...source,
    ...(routed ? { action: evidence.action } : {}) } };
}

export async function inspectOwnPr(api, number, context, options = {}) {
  const source = options.commandId ?? options.evidence?.sourceId;
  const [pr, editors, comments, threads] = await Promise.all([
    api.pull(number), api.editors(number, "pullRequest"), api.comments(number),
    options.includeRequests || source?.startsWith("review-comment:") ? api.threads(number) : [],
  ]);
  return { ...authorizeOwnPr({ pr, editors, comments, threads, config: context.config, repo: context.repo,
    defaultBranch: context.defaultBranch, ...options }), pr, requests: prCommandFacts(pr, comments, threads, context.config) };
}

export async function readFeedback(api, { issue, prs }, config) {
  const all = [];
  if (issue) {
    const [comments, events] = await Promise.all([api.comments(issue), api.events(issue)]);
    for (const fact of comments) all.push(classifyText(fact, "issue-comment", config, { target: issue }));
    for (const event of events) { const fact = classifyLabel(event, config, issue); if (fact) all.push(fact); }
  }
  for (const pr of prs) {
    const [comments, reviews, threads] = await Promise.all([api.comments(pr), api.reviews(pr), api.threads(pr)]);
    for (const fact of comments) all.push(classifyText(fact, "issue-comment", config, { target: pr }));
    for (const fact of reviews) all.push({ ...classifyText(fact, "review", config, { target: pr, state: fact.state, head: fact.commitSha }),
      requiresResponse: fact.state === "CHANGES_REQUESTED" });
    for (const thread of threads) {
      const facts = thread.comments.map((fact) => ({ ...classifyText(fact, "review-comment", config, { target: pr, thread: thread.id }), requiresResponse: !thread.isResolved }));
      const revision = threadRevision(facts);
      for (const fact of facts) all.push({ ...fact, threadRevision: revision });
    }
  }
  const unique = new Map();
  for (const fact of all) {
    const previous = unique.get(fact.sourceId);
    if (previous && (previous.revision !== fact.revision || previous.target !== fact.target || previous.thread !== fact.thread)) throw new Error("Feedback changed during the read; reobserve it before acting");
    unique.set(fact.sourceId, fact);
  }
  return [...unique.values()].sort(compareRequests);
}
