import { createHash } from "node:crypto";
import { apiEffectId, factoryLabels, runApiEffect } from "./api-journal.mjs";
import { apiWriter } from "./api-writer.mjs";
import { loadConfig } from "./config.mjs";
import { readFeedback } from "./admission.mjs";
import { observeAuthorization, observeItem } from "./observe.mjs";
import { pendingControls } from "./commands.mjs";
import { pendingWrites, pendingText, preflightRead, preflightId } from "./recovery.mjs";
import { evolve, TERMINAL } from "./protocol.mjs";
import { factoryReadApi } from "./identity.mjs";
import { itemUsage, usageText } from "./usage.mjs";
import { publicationGaps, publishedPushes } from "./effects.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const ownNumber = (item) => Number(item.key.split(":")[1]);
const hidden = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
const alertReference = (alert) => alert.source === "preflight" ? `Observation: \`${alert.read}\`` : `Request: \`${alert.request}\``;
const nextText = (status) => ({ answer: "Answer the question with /agent answer <text>.", "work-command": "A work command resumes this item.",
  ci: "The current commit's CI result wakes the controller.", signals: "The configured review/check results wake the controller.",
  "main-green": "Work resumes after the default branch's required checks pass.", "owner-terminal": "The worker's completion wakes the controller.",
  "publish-outcome": "A later event or backstop pass inspects the original request; an unknown write is never resent.",
  "issue-reopen": "The recorded reopen request is inspected before existing work resumes.",
  landing: "The next controller pass rechecks the recorded commits; missing evidence has a bounded deadline.",
  handover: "Review the PR and enable auto-merge when you want it to land.", "close-out": "Record completion of the required work.",
  none: "The next relevant GitHub event or backstop pass checks this item again." })[status.next]
  ?? `Next: ${status.next.replaceAll("-", " ")}.`;

export function projectItem(ledger, key) {
  const item = ledger.items[key], op = ledger.operations[item.activeOperation];
  const pending = pendingWrites(ledger, key);
  const usage = itemUsage(ledger, key);
  const alerts = Object.values(item.apiAlerts ?? {}).filter((a) => a.status === "active");
  const gaps = publicationGaps(ledger, key);
  const fallback = { state: "agent-ready", reason: "Accepted work is queued", next: "dispatch", wait: null };
  const summary = item.paused ? { state: "agent-stopped", reason: "Automatic work is paused", next: "work-command", wait: null }
    : item.question ? { state: item.status?.state === "agent-failed" ? "agent-failed" : "agent-needs-you", reason: item.question.reason, next: "answer", wait: null }
    : item.status ?? fallback;
  const prs = item.prs.map((pr) => ({ number: pr.number, state: gaps.some((g) => g.number === pr.number && !g.accepted) ? item.question ? "agent-needs-you" : "agent-waiting" : pr.state === "merged" ? "agent-complete"
    : pr.state === "closed" ? pr.acceptedClosure || !pr.required ? "agent-complete" : "agent-needs-you" : summary.state,
  reason: pr.state === "merged" ? `Merged at ${pr.mergedSha}` : pr.state === "closed" ? pr.acceptedClosure || !pr.required
    ? "Closed with an accepted disposition" : "Closed without merging; an explicit disposition is needed" : summary.reason,
  next: gaps.some((g) => g.number === pr.number && !g.accepted) ? summary.next
    : pr.state === "merged" || pr.state === "closed" && (pr.acceptedClosure || !pr.required) ? "none" : summary.next,
  terminal: pr.state !== "open" }));
  const targets = [...prs.map((p) => ({ target: p.number, status: p }))];
  if (!item.evidence.own) targets.unshift({ target: ownNumber(item), status: summary });
  return targets.map(({ target, status }) => {
    const data = { item: key, state: status.state.replace(/^agent-/, ""), reason: status.reason, next: status.next,
      generation: item.generation, operation: op?.id ?? null, run: op?.owner?.id ?? null, prs, pendingWrites: pending, alerts, usage };
    const lines = [`**${status.state}:** ${status.reason}`, "", nextText(status)];
    const relevantAlerts = target === ownNumber(item) ? alerts : alerts.filter((a) => a.target === target);
    if (relevantAlerts.length) lines.push("", "**Needs attention:**", ...relevantAlerts.map((a) => `- ${a.reason} ${alertReference(a)}.`));
    const relevant = target === ownNumber(item) ? pending : pending.filter((w) => w.target === target);
    if (relevant.length) lines.push(pendingText(relevant));
    if (target === ownNumber(item) && !item.evidence.own && prs.length) {
      lines.push("", ...prs.map((p) => `- #${p.number}: ${p.state} — ${p.reason}`));
    }
    if (status.wait?.deadline) lines.push("", `Wait deadline: ${status.wait.deadline}.`);
    const publications = publishedPushes(ledger, key).reverse().filter((r) => r.pr.required && r.pr.state === "merged"
      && (target === ownNumber(item) || r.number === target)).slice(0, 10);
    if (publications.length) lines.push("", ...publications.map((r) => {
      const gap = gaps.find((g) => g.request === r.id);
      return `Published \`${r.commit}\` on #${r.number}; recorded merge \`${r.pr.mergedSha}\`. ${!gap ? "Landing is verified." : gap.accepted
        ? "The merged outcome was explicitly accepted." : "Landing is not verified; completion waits for evidence or a decision."}`;
    }));
    if (item.attempts.length || usage.routingRequests) lines.push("", usageText(usage));
    const marker = `<!-- factory:status=${key}/${target} -->`;
    lines.push("", marker, `<!-- agent-ready:state ${hidden(data)} -->`);
    return { target, status, body: lines.join("\n"), marker };
  });
}

export function surfaceService({ api, write, store, repo, appLogin, run, now = () => new Date().toISOString(), assertRuntime = async () => {} }) {
  api = factoryReadApi(api, appLogin.toLowerCase());
  const writer = apiWriter({ api, write, appLogin });
  const own = (row) => row?.user?.login?.toLowerCase() === appLogin.toLowerCase();
  const currentItem = async (key) => (await store.load()).state.items[key];
  const execute = (key, slot, definition, guard, recoverOnly = false) => runApiEffect({ store, key, slot, definition, run, writer,
    guard: async (...args) => { await assertRuntime(); return guard ? guard(...args) : true; }, now, recoverOnly });
  const sameIntent = (item, definition) => !definition.guard || item.generation === definition.guard.generation
    && item.revision === definition.guard.revision && !item.paused;
  async function freshCommand(item, id) {
    const command = item.commands[id];
    if (!command) return false;
    const { config } = await loadConfig(api);
    const feedback = await readFeedback(api, { issue: item.evidence.own ? null : ownNumber(item), prs: item.prs.map((p) => p.number) }, config);
    return feedback.some((f) => f.sourceId === command.sourceId && f.revision === command.revision && f.target === command.target
      && f.authority === "instruction" && f.command);
  }
  async function workGuard(key, definition) {
    const item = await currentItem(key);
    if (item.authorizationRevoked || !sameIntent(item, definition)) return false;
    if (item.continuation?.phase === "requested" && definition.kind !== "issue-reopen") return false;
    const latest = { ...await loadConfig(api), repo };
    const { authorization } = await observeAuthorization(api, item, latest);
    if (!authorization.valid || authorization.revision !== item.revision) return false;
    if (definition.payload.head) {
      const pr = await api.pull(definition.target);
      if (pr.state !== "open" || pr.head?.sha !== definition.payload.head || pr.head.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) return false;
      if (definition.kind === "ci-rerun" && pr.base?.ref !== latest.defaultBranch) return false;
      if (["ready", "review-request", "pr-close"].includes(definition.kind) && !own(pr)) return false;
    }
    if (definition.guard?.commandId && !await freshCommand(item, definition.guard.commandId)) return false;
    const feedback = await readFeedback(api, { issue: item.evidence.own ? null : ownNumber(item), prs: item.prs.map((p) => p.number) }, latest.config);
    return pendingControls(item, feedback, definition.guard?.commandId ? [definition.guard.commandId] : []).length === 0;
  }
  async function comment(key, slot, target, body, marker, guard = async () => true) {
    const item = await currentItem(key), existing = item.apiEffects?.[apiEffectId(slot)];
    // A surface's first body is immutable in the create journal; later desired
    // bodies are explicit edits of the recovered comment, never another create.
    const definition = existing?.definition ?? { kind: "comment-create", target, payload: { body: body.includes(marker) ? body : `${body}\n\n${marker}`, marker } };
    if (definition.kind !== "comment-create" || definition.target !== target || definition.payload.marker !== marker) throw new Error("Comment surface identity mismatch");
    return execute(key, slot, definition, guard);
  }
  async function statusComment(key, projection, item) {
    const { target, body, marker } = projection;
    const matches = await preflightRead({ store, key, item, kind: "status", target, stage: "plan", now,
      read: async () => {
        const matches = (await write.comments(target)).filter((c) => own(c) && c.body?.includes(marker));
        if (matches.length > 1) throw new Error("Several App comments claim one status surface");
        return matches;
      } });
    let found = matches[0], slot = `status:${key}:${target}`;
    if (found && item.preflights?.[preflightId("status", target, "inspect")]?.status === "failed") {
      await preflightRead({ store, key, item, kind: "status", target, stage: "inspect", now, read: async () => found });
    }
    for (let recovery = 0; !found && recovery < 10; recovery++) {
      const posted = await comment(key, slot, target, body, marker);
      if (posted.status !== "applied") return posted;
      found = await preflightRead({ store, key, item, kind: "status", target, stage: "inspect", now,
        read: async () => {
          try { return await write.commentById("issue-comment", posted.receipt.id); }
          catch (error) { if (error.status !== 404) throw error; return null; }
        } });
      if (!found) {
        // Only an authoritative deletion of a known, successfully created
        // comment allows a replacement. Absence after a timeout does not.
        slot += `:after-${posted.receipt.id}`;
      }
    }
    if (!found) throw new Error("Status replacement limit exceeded");
    if (found.body === body) return { status: "applied", receipt: { id: found.id } };
    return execute(key, `status-edit:${key}:${target}:${found.id}:${hash(body)}`, {
      kind: "comment-edit", target, payload: { id: found.id, body, marker },
    });
  }
  async function labels(key, projection, item) {
    const existing = await preflightRead({ store, key, item, kind: "labels", target: projection.target, stage: "plan", now,
      read: async () => (await api.issue(projection.target)).labels.map((l) => l.name ?? l) });
    const results = [];
    for (const label of existing.filter((l) => factoryLabels.has(l) && l !== projection.status.state)) {
      results.push(await execute(key, `label-remove:${projection.target}:${label}`, { kind: "label-remove", target: projection.target, payload: { label } }));
    }
    if (!existing.includes(projection.status.state)) results.push(await execute(key, `label-add:${projection.target}:${projection.status.state}`, {
      kind: "label-add", target: projection.target, payload: { label: projection.status.state },
    }));
    return results;
  }
  const acknowledgementText = (command, item, ledger) => {
    if (command.clarification) return `This request needs clarification: ${command.clarification}`;
    if (command.status === "superseded") return "This request was superseded by a later command.";
    if (command.mainAnswer) return command.mainAnswer;
    if (command.issueClosureDecision === "stop") return `Work is paused. An earlier reopening request may still finish.${pendingText(pendingWrites(ledger, item.key))}`;
    if (command.issueClosureDecision === "continue") return command.issueClosureOutcome === "done" ? "The issue reopening for this request is recorded."
      : command.issueClosureOutcome === "superseded" ? `The continue request stopped: ${command.issueClosureReason}`
        : "Reopening the issue before continuing its existing work.";
    const disposition = item.prs.find((p) => p.acceptedClosure && p.dispositions?.some((d) => d.commandId === command.id));
    if (disposition) return `The closure of PR #${disposition.number} is accepted. Completion still requires every other required PR to be accounted for.`;
    if (command.action === "answer" && item.completionAcceptance?.sourceId === command.sourceId) return "The recorded merged work was explicitly accepted; recording completion.";
    return ({ stop: `Work is paused. A request already sent may still finish.${pendingText(pendingWrites(ledger, item.key))}`,
      status: `${item.status?.state ?? "Queued"}: ${item.status?.reason ?? "Accepted work is queued"}. ${nextText(item.status ?? { next: "dispatch" })}`,
      effort: `Using ${command.effort} effort for subsequent runs.`, answer: "Resuming the existing work with your answer.",
      respond: "Working on the existing PR with your feedback.", resolve: "Merging the default branch in and resolving conflicts.",
      update: "Bringing the branch up to date with a merge. Conflicts will start a resolve run.", build: "Working on this issue and its existing PRs, if any.",
      restart: "Closing the recorded open PRs before starting a replacement build.", retry: "Inspecting the previous attempt and retrying within its limits.",
      clarify: command.text || "Specify the action you want with /agent <action>." })[command.action];
  };
  async function acknowledge() {
    const { state } = await store.load(), notes = []; let count = 0;
    for (const item of Object.values(state.items)) for (const command of Object.values(item.commands).filter((c) => c.acknowledgement === "pending")) {
      if (count++ >= 50) return [...notes, { surface: "acknowledgement", status: "waiting", reason: "The pass acknowledgement limit was reached" }];
      try {
        const [sourceKind, rawId] = command.sourceId.split(":"), guard = () => freshCommand(item, command.id);
        const reaction = sourceKind === "label" ? { status: "applied" }
          : await execute(item.key, `ack-eyes:${command.id}`, { kind: "reaction", target: command.target,
            payload: { id: Number(rawId), sourceKind, content: "eyes" } }, guard);
        if (command.action === "route") continue;
        const text = acknowledgementText(command, item, (await store.load()).state);
        const reply = await comment(item.key, `ack-reply:${command.id}`, command.target, text,
          `<!-- factory:ack=${command.id} -->`, guard);
        if (reaction.status === "applied" && reply.status === "applied") await store.transact((s) => {
          s.items[item.key].commands[command.id].acknowledgement = "done"; return s;
        });
        else notes.push({ key: item.key, surface: "acknowledgement", status: "waiting" });
      } catch (error) { notes.push({ key: item.key, surface: "acknowledgement", status: "interrupted", reason: error.message }); }
    }
    return notes;
  }
  async function requestReview(key, target, head, slot, context, extraGuard = async () => true) {
    const item = await currentItem(key);
    if (item.evidence.own) return { status: "applied" };
    const reviewers = context.config.trustedUsers.includes(item.evidence.actor?.toLowerCase()) ? [item.evidence.actor.toLowerCase()] : [context.config.trustedUsers[0]];
    const definition = { kind: "review-request", target, payload: { head, reviewers },
      guard: { generation: item.generation, revision: item.revision } };
    return execute(key, slot, definition, async () => await workGuard(key, definition) && await extraGuard());
  }
  async function handover({ key, number, head, context, readyOnly = false }) {
    const item = await currentItem(key);
    if (item.evidence.own) return { status: "applied" };
    const binding = { generation: item.generation, revision: item.revision };
    const pr = await preflightRead({ store, key, item, kind: "ready", target: number, stage: "plan", guard: binding, now, read: () => api.pull(number) });
    if (!own(pr) || pr.state !== "open" || pr.head.sha !== head) return { status: "superseded" };
    const definition = { kind: "ready", target: number, payload: { head, nodeId: pr.node_id },
      guard: { generation: item.generation, revision: item.revision } };
    const guard = async () => {
      if (!await workGuard(key, definition)) return false;
      const { state } = await store.load(), latest = { ...await loadConfig(api), repo };
      const active = state.operations[state.items[key].activeOperation];
      if (active && !["done", "failed", "superseded"].includes(active.phase)) return false;
      const facts = await observeItem({ api, actions: null, ledger: state, key, context: latest, rules: await api.branchRules(latest.defaultBranch), now, landingLimit: 0 });
      const current = facts.prs.find((p) => p.number === number);
      return !current?.unsupported && current?.headSha === head && current.checks?.state === "success" && current.mergeable === "MERGEABLE"
        && (readyOnly || !current.signals?.pending?.length) && !(current.feedback ?? []).some((f) => f.requiresResponse
          && ["instruction", "signal"].includes(f.authority) && state.items[key].feedback?.[f.sourceId] !== f.revision);
    };
    if (!await preflightRead({ store, key, item, kind: "ready", target: number, stage: "guard", guard: binding, now, read: guard })) return { status: "superseded" };
    const ready = await execute(key, `ready:${number}:${head}:${item.generation}`, definition, guard);
    if (ready.status !== "applied" || readyOnly) return ready;
    return requestReview(key, number, head, `handover-review:${number}:${head}:${item.generation}`, context, guard);
  }
  async function render(ledger, context, outcomes = []) {
    for (const item of Object.values(ledger.items)) {
      for (const effect of Object.values(item.apiEffects ?? {}).filter((e) => e.status === "pending"
        || ["prepared", "rejected"].includes(e.status) && !sameIntent(item, e.definition))) {
        try { await execute(item.key, effect.slot, effect.definition, undefined, true); }
        catch (error) { outcomes.push({ key: item.key, surface: "receipt", status: "waiting", reason: error.message }); }
      }
      await store.transact((s) => evolve(s, item.key, { type: "sync-api-alerts", at: now(), timeoutMinutes: context.config.timeouts.publishMinutes ?? 15 }));
      const snapshot = (await store.load()).state;
      for (const projection of projectItem(snapshot, item.key)) {
        let status, projected;
        try {
          status = await statusComment(item.key, projection, snapshot.items[item.key]);
        } catch (error) { outcomes.push({ key: item.key, surface: "status", status: error.code === "preflight-wait" ? "waiting" : "interrupted", reason: error.message }); }
        try {
          projected = await labels(item.key, projection, snapshot.items[item.key]);
        } catch (error) { outcomes.push({ key: item.key, surface: "labels", status: error.code === "preflight-wait" ? "waiting" : "interrupted", reason: error.message }); }
        if (status?.status !== "applied" || projected?.some((r) => r.status !== "applied")) outcomes.push({ key: item.key, surface: "status", status: "waiting" });
      }
      let current = await currentItem(item.key);
      if (JSON.stringify(current.preflights) !== JSON.stringify(snapshot.items[item.key].preflights)) {
        await store.transact((s) => evolve(s, item.key, { type: "sync-api-alerts", at: now(), timeoutMinutes: context.config.timeouts.publishMinutes ?? 15 }));
        current = await currentItem(item.key);
      }
      for (const alert of Object.values(current.apiAlerts ?? {})) {
        try {
          const slot = `attention:${alert.id}`, marker = `<!-- factory:attention=${alert.id} -->`;
          if (alert.status === "active" && !current.paused) {
            const body = `**Needs attention:** ${alert.reason}\n\n${alertReference(alert)}.\n\n${marker}`;
            const posted = await comment(item.key, slot, alert.target,
              body,
              marker, async () => { const fresh = await currentItem(item.key); return !fresh.paused && fresh.apiAlerts?.[alert.id]?.status === "active"; });
            if (posted.status !== "applied") outcomes.push({ key: item.key, surface: "attention", status: "waiting" });
            else await execute(item.key, `attention-edit:${alert.id}:${hash(body)}`, { kind: "comment-edit", target: alert.target,
              payload: { id: posted.receipt.id, body, marker } }, async () => {
                const fresh = await currentItem(item.key), present = fresh.apiAlerts?.[alert.id];
                return !fresh.paused && present?.id === alert.id && present.status === "active";
              });
          } else if (alert.status === "resolved") {
            const notice = current.apiEffects?.[apiEffectId(slot)];
            if (notice?.status === "applied" && current.apiEffects?.[apiEffectId(`attention-resolved:${alert.id}`)]?.status !== "applied") {
              const body = alert.resolution === "observed" ? `**Recovered:** ${alert.kind} preconditions on #${alert.target} can be observed again.\n\n${marker}`
                : alert.source === "preflight" ? `**Settled:** ${alert.kind} preconditions on #${alert.target} belong to superseded work.\n\n${marker}`
                  : alert.resolution === "applied" ? `**Recovered:** ${alert.kind} on #${alert.target} was observed.\n\n${marker}`
                    : `**Settled:** ${alert.kind} on #${alert.target} was superseded; no new request will be sent.\n\n${marker}`;
              await execute(item.key, `attention-resolved:${alert.id}`, { kind: "comment-edit", target: alert.target,
                payload: { id: notice.receipt.id, body, marker } }, async () => {
                  const present = (await currentItem(item.key)).apiAlerts?.[alert.id];
                  return present?.id === alert.id && present.status === "resolved";
                });
            }
          }
        } catch (error) { outcomes.push({ key: item.key, surface: "attention", status: "interrupted", reason: error.message }); }
      }
      if (!item.paused && item.question) {
        const question = item.question, id = question.id ?? hash(`${item.key}:${question.operation}:${question.reason}`);
        const target = question.kind === "pr-closure" ? question.number
          : item.prs.find((p) => p.state === "open")?.number ?? item.prs.find((p) => p.required)?.number ?? ownNumber(item);
        try {
          const posted = await comment(item.key, `question:${id}`, target,
            `**Needs you:** ${question.reason}\n\n${question.kind === "publish-outcome" ? "You can reply with investigation details, but recovery needs a verified remote outcome."
              : question.kind === "authorization" ? "A new trusted admission source is required before work can resume." : "Reply with `/agent answer <your answer>`."} Use \`/agent stop\` to pause work.`,
            `<!-- factory:question=${id} -->`, async () => {
              const current = await currentItem(item.key);
              return !current.paused && current.question?.reason === question.reason && current.question?.id === question.id;
            });
          if (posted.status !== "applied") outcomes.push({ key: item.key, surface: "question", status: "waiting" });
          if (posted.status === "applied" && !item.evidence.own && item.prs.some((p) => p.number === target)) {
            const pr = await preflightRead({ store, key: item.key, item: current, kind: "notification", target, stage: "plan", now,
              guard: { generation: current.generation, revision: current.revision }, read: () => api.pull(target) });
            if (pr.state === "open") {
              const review = await requestReview(item.key, target, pr.head.sha, `question-review:${id}:${pr.head.sha}`, context);
              if (review.status !== "applied") outcomes.push({ key: item.key, surface: "question-review", status: "waiting" });
            }
          }
        } catch (error) { outcomes.push({ key: item.key, surface: "question", status: "interrupted", reason: error.message }); }
      }
    }
    return outcomes;
  }
  async function closeOut({ key }) {
    const { state } = await store.load(), item = state.items[key];
    if (item.evidence.own || !item.complete || publicationGaps(state, key).some((g) => !g.accepted)) return { status: "superseded" };
    const definition = { kind: "issue-close", target: ownNumber(item), payload: { revision: item.revision },
      guard: { generation: item.generation, revision: item.revision } };
    return execute(key, `close-out:${key}:${item.generation}:${item.revision}`, definition, async () => {
      if (!await workGuard(key, definition)) return false;
      const { state: latest } = await store.load(), current = latest.items[key], required = current.prs.filter((p) => p.required), op = latest.operations[current.activeOperation];
      if (!current.complete || !required.length || op && !TERMINAL.has(op.phase) || publicationGaps(latest, key).some((g) => !g.accepted)) return false;
      for (const recorded of required) {
        const actual = await api.pull(recorded.number);
        if (recorded.state === "merged" ? !actual.merged_at || actual.merge_commit_sha !== recorded.mergedSha
          : recorded.state !== "closed" || !recorded.acceptedClosure || actual.state !== "closed") return false;
      }
      return true;
    });
  }
  async function rerunCi({ key, number, head, testedSha, runIds, context }) {
    if (!Array.isArray(runIds) || !runIds.length || runIds.length > 10) throw new Error("A bounded list of failing CI runs is required");
    const item = await currentItem(key), results = [];
    for (const id of [...new Set(runIds.map(String))]) {
      if (!/^[1-9]\d*$/.test(id)) throw new Error("Invalid CI run identity");
      const slot = `ci-rerun:${key}:${number}:${head}:${id}:${item.generation}`, existing = item.apiEffects?.[apiEffectId(slot)];
      let definition = existing?.definition;
      if (!definition) {
        const actual = await preflightRead({ store, key, item, kind: "ci-rerun", target: number, stage: "plan", runId: id,
          guard: { generation: item.generation, revision: item.revision }, now, read: async () => {
            const actual = await api.run(id);
            if (String(actual.id) !== id || String(actual.repository?.id) !== context.repositoryId
              || String(actual.head_repository?.id) !== context.repositoryId || ![head, testedSha].includes(actual.head_sha)
              || actual.path === ".github/workflows/factory.yml" || !Number.isSafeInteger(actual.run_attempt) || actual.run_attempt < 1) throw new Error("CI rerun is not the recorded current-head check run");
            return actual;
          } });
        definition = { kind: "ci-rerun", target: number, payload: { head, testedSha, runHead: actual.head_sha, runId: id, attempt: actual.run_attempt },
          guard: { generation: item.generation, revision: item.revision } };
      }
      results.push(await execute(key, slot, definition, () => workGuard(key, definition)));
    }
    return results;
  }
  async function recoverCi({ key, effectId }) {
    const item = await currentItem(key), effect = item.apiEffects?.[effectId];
    if (effect?.definition.kind !== "ci-rerun") throw new Error("Unknown CI rerun effect");
    return execute(key, effect.slot, effect.definition, () => workGuard(key, effect.definition));
  }
  return { acknowledge, render, handover, closeOut, rerunCi, recoverCi, execute, writer, workGuard };
}
