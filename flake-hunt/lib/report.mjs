// Acts on triage.json: opens, comments on or reopens issues, then writes
// the job summary. A dry run only writes the summary, with the bodies it
// would have posted.
//
// With an agent (agent-ready's caller workflow), the new and reopened
// flakes are grouped by likely cause (group.mjs), and each group's first
// issue gets the agent's label and a dispatched run. The others in the
// group point at it and get no run of their own, unless a later hunt
// finds one still flaky after the first issue has closed.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { displayName, followerBlock, followerNote, groupBlock, leadOf, planIssues, renderComment, renderIssue, renderSummary, titleFor, withBlock } from "./issues.mjs";
import { groupFlakes } from "./group.mjs";

function readDiagnosis(dir, id) {
  const file = join(dir, `${id}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  return text === "" ? null : text;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The plan as units of work: each flake alone, except that the ones that
// may start a run (pooled) and fail the same way are one unit, the first
// in the plan leading. Ordered by their first member.
function unitsOf(plan, pooled) {
  const pool = plan.map((p, i) => i).filter(pooled);
  const grouped = new Map();
  for (const g of groupFlakes(pool.map((i) => plan[i].flake))) {
    const unit = g.map((k) => pool[k]);
    grouped.set(unit[0], unit);
  }
  const inPool = new Set(pool);
  return plan.map((p, i) => i).flatMap((i) => (grouped.has(i) ? [grouped.get(i)] : inPool.has(i) ? [] : [[i]]));
}

export async function runReport({ triageDir, diagnosesDir, label, dryRun, gh, ctx, summaryFile, agent = null, log = console.log }) {
  const triage = JSON.parse(readFileSync(join(triageDir, "triage.json"), "utf8"));
  const fullCtx = { ...ctx, workingDirectory: triage.workingDirectory };
  const previews = [];
  let attempted = 0;
  let failed = 0;

  // Plan again from the issues as they are now. A rerun of a report that
  // failed partway, or a later hunt's report, would otherwise open a
  // second issue or start a second agent. Only new and reopened flakes
  // are grouped, so a rerun doesn't group again either.
  const issues = dryRun ? [] : await gh.listIssues(label);
  const plan = dryRun
    ? triage.plan
    : planIssues(
        triage.plan.map((p) => p.flake),
        issues,
      ).map((p, i) => ({ ...p, diagnose: triage.plan[i].diagnose }));
  const open = new Set(issues.filter((i) => i.state === "open").map((i) => i.number));
  const results = plan.map((p) => ({ flake: p.flake, action: p.action, issue: p.issue }));

  if (!dryRun && plan.some((p) => p.action === "create")) {
    try {
      await gh.ensureLabel(label);
    } catch (e) {
      log(`::warning::Couldn't check the ${label} label: ${e.message}`);
    }
  }

  // One of a group's others, still open and still flaky, whose first
  // issue has been closed since: the fix didn't cover it, or didn't hold.
  // A still-open issue otherwise only gets a comment.
  const promotable = (i) => {
    const p = plan[i];
    const lead = agent && !dryRun && p.action === "comment" ? leadOf(p.issue?.body) : null;
    return lead !== null && !open.has(lead);
  };
  // What may start a run, and so is grouped with the rest of this hunt.
  const mayStart = (i) => Boolean(agent) && (plan[i].action === "create" || plan[i].action === "reopen" || promotable(i));

  const fail = (i, e) => {
    const result = results[i];
    failed += 1;
    const n = result.issue?.number;
    result.error =
      result.done && result.agent
        ? `couldn't start ${agent.workflow}: ${e.message}. Once that's fixed, start it with \`gh workflow run ${agent.workflow} -f issue=${n}\``
        : e.message;
    log(`::error::${plan[i].flake.module} "${plan[i].flake.name}": ${result.error}`);
  };

  // Files one flake: opens, comments on or reopens its issue. block is
  // its same-cause block (null takes an old one out of a reopened issue,
  // and undefined leaves the body alone), note goes in a comment, and withAgent labels it for a run. Returns
  // the body it left the issue with, or null when it failed.
  const file = async (i, { block = undefined, note = null, withAgent = false, follows = null } = {}) => {
    const p = plan[i];
    const result = results[i];
    if (withAgent) result.agent = agent.workflow;
    if (follows) result.follows = follows;
    attempted += 1;
    const diagnosis = p.diagnose ? readDiagnosis(diagnosesDir, p.diagnose) : null;
    const title = titleFor(p.flake, triage.workingDirectory);
    const body =
      p.action === "create"
        ? withBlock(renderIssue(p.flake, fullCtx, diagnosis), block)
        : renderComment(p.flake, fullCtx, { reopened: p.action === "reopen", diagnosis, note });

    if (dryRun) {
      const what = p.action === "create" ? `Issue: ${title}` : `Comment on #${p.issue.number}`;
      previews.push(`<details><summary>${escapeHtml(what)}</summary>\n\n${body}\n</details>`);
      return null;
    }
    try {
      if (p.action === "create") {
        const issue = await gh.createIssue({ title, body, labels: withAgent ? [label, agent.label] : [label] });
        result.issue = { number: issue.number };
        result.done = true;
        return body;
      }
      // In this order so a rerun after a failure plans the same thing: the
      // issue stays closed until the last step, and a pointer to a closed
      // first issue goes only once the label is on.
      if (withAgent) await gh.addLabels(p.issue.number, [agent.label]);
      await gh.comment(p.issue.number, body);
      const now = block === undefined ? (p.issue.body ?? "") : withBlock(p.issue.body, block);
      if (now !== (p.issue.body ?? "")) await gh.setBody(p.issue.number, now);
      if (p.action === "reopen") await gh.reopen(p.issue.number);
      result.done = true;
      return now;
    } catch (e) {
      fail(i, e);
      return null;
    }
  };

  const start = async (i) => {
    if (dryRun || !results[i].done) return;
    try {
      await gh.dispatch(agent.workflow, agent.ref, { issue: String(results[i].issue.number) });
    } catch (e) {
      fail(i, e);
    }
  };

  // A group: the first issue, then the others pointing at it, then the
  // first's body lists the ones that were filed, and only then its run
  // starts. If the first can't be filed, the next one leads.
  const group = async (unit) => {
    const [first, ...rest] = unit;
    const was = promotable(first) ? leadOf(plan[first].issue.body) : null;
    if (was !== null) results[first].promoted = was;
    const note = was !== null ? `#${was} is closed and this still flakes, so it gets an agent run of its own.` : null;
    const body = await file(first, { withAgent: true, note });
    if (!dryRun && body === null) return rest.length ? group(rest) : undefined;
    const lead = dryRun ? `${plan[first].flake.module} "${displayName(plan[first].flake.name)}"` : results[first].issue.number;
    const others = [];
    for (const i of rest) {
      const ok = await file(i, { block: dryRun ? null : followerBlock(lead), note: dryRun ? null : followerNote(lead), follows: dryRun ? lead : `#${lead}` });
      others.push(dryRun ? i : ok !== null ? results[i].issue.number : null);
    }
    results[first].others = others.filter((n) => n !== null);
    // Also takes a list from an earlier hunt out of a reopened issue.
    const listed = withBlock(body, results[first].others.length ? groupBlock(results[first].others) : null);
    if (!dryRun && listed !== body) {
      try {
        await gh.setBody(lead, listed);
      } catch (e) {
        // The run still starts, on this issue alone, but the others are
        // told it works them too, so say so.
        failed += 1;
        results[first].error = `couldn't list the others on it: ${e.message}`;
        log(`::error::#${lead}: ${results[first].error}`);
      }
    }
    await start(first);
  };

  for (const unit of unitsOf(plan, (i) => mayStart(i))) {
    const [i] = unit;
    if (plan[i].action === "skip") continue;
    if (mayStart(i)) await group(unit);
    else await file(i);
  }

  let summary = renderSummary({
    workingDirectory: triage.workingDirectory,
    runs: triage.runs,
    testCount: triage.testCount,
    dryRun,
    diagnosis: triage.diagnosisNote,
    results,
    broken: triage.broken,
  });
  if (previews.length > 0) summary += `\n### What would be posted\n\n${previews.join("\n\n")}\n`;
  if (summaryFile) appendFileSync(summaryFile, summary);
  else log(summary);

  if (failed > 0) throw new Error(`${failed} of ${attempted} issue updates failed`);
  return { results };
}
