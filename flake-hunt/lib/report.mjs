// Acts on triage.json: opens, comments on or reopens issues, then writes
// the job summary. A dry run only writes the summary, with the bodies it
// would have posted.
//
// With an agent (agent-ready's caller workflow), each new or reopened
// issue also gets the agent's label and a dispatched run on it.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderComment, renderIssue, renderSummary, titleFor } from "./issues.mjs";

function readDiagnosis(dir, id) {
  const file = join(dir, `${id}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  return text === "" ? null : text;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function runReport({ triageDir, diagnosesDir, label, dryRun, gh, ctx, summaryFile, agent = null, log = console.log }) {
  const triage = JSON.parse(readFileSync(join(triageDir, "triage.json"), "utf8"));
  const fullCtx = { ...ctx, workingDirectory: triage.workingDirectory };
  const results = [];
  const previews = [];
  let attempted = 0;
  let failed = 0;

  if (!dryRun && triage.plan.some((p) => p.action === "create")) {
    try {
      await gh.ensureLabel(label);
    } catch (e) {
      log(`::warning::Couldn't check the ${label} label: ${e.message}`);
    }
  }

  for (const p of triage.plan) {
    const result = { flake: p.flake, action: p.action, issue: p.issue };
    results.push(result);
    if (p.action === "skip") continue;
    if (agent && p.action !== "comment") result.agent = agent.workflow;

    attempted += 1;
    const diagnosis = p.diagnose ? readDiagnosis(diagnosesDir, p.diagnose) : null;
    const title = titleFor(p.flake, triage.workingDirectory);
    const body =
      p.action === "create"
        ? renderIssue(p.flake, fullCtx, diagnosis)
        : renderComment(p.flake, fullCtx, { reopened: p.action === "reopen", diagnosis });

    if (dryRun) {
      const what = p.action === "create" ? `Issue: ${title}` : `Comment on #${p.issue.number}`;
      previews.push(`<details><summary>${escapeHtml(what)}</summary>\n\n${body}\n</details>`);
      continue;
    }

    try {
      if (p.action === "create") {
        const issue = await gh.createIssue({ title, body, labels: result.agent ? [label, agent.label] : [label] });
        result.issue = { number: issue.number };
      } else {
        await gh.comment(p.issue.number, body);
        if (p.action === "reopen") await gh.reopen(p.issue.number);
        if (result.agent) await gh.addLabels(p.issue.number, [agent.label]);
      }
      result.done = true;
      if (result.agent) await gh.dispatch(agent.workflow, agent.ref, { issue: String(result.issue.number) });
    } catch (e) {
      failed += 1;
      result.error = result.done && result.agent ? `couldn't start ${agent.workflow}: ${e.message}` : e.message;
      log(`::error::${p.flake.module} "${p.flake.name}": ${result.error}`);
    }
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
