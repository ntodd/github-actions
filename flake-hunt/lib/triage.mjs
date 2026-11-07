// Reads every shard's results, finds the flaky tests, matches them to
// issues and writes a prompt for each one Claude should look at.
//
// Writes, under outDir:
//   triage.json      what the report step acts on
//   prompts/dN.md    one per flake to diagnose

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate, classify, parseJsonl } from "./aggregate.mjs";
import { planIssues } from "./issues.mjs";
import { renderPrompt } from "./prompt.mjs";

function jsonlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(dir, f));
}

function issueRef(issue) {
  return issue ? { number: issue.number, state: issue.state, state_reason: issue.state_reason ?? null } : null;
}

export async function runTriage({ resultsDir, outDir, workingDirectory, label, maxDiagnoses, canDiagnose, gh, template, log = console.log }) {
  const records = jsonlFiles(resultsDir).flatMap((file) =>
    parseJsonl(readFileSync(file, "utf8"), (line) => log(`::warning::Skipped a bad line in ${file}: ${line.slice(0, 200)}`)),
  );
  const { runs, tests } = aggregate(records, { workingDirectory });
  if (runs.reported === 0) {
    throw new Error(`No run reported any tests (${runs.total} runs). The suite may not compile, or setup failed: check the hunt job's logs.`);
  }

  const { flaky, broken } = classify(tests);
  const issues = flaky.length > 0 ? await gh.listIssues(label) : [];
  const plan = planIssues(flaky, issues);

  mkdirSync(join(outDir, "prompts"), { recursive: true });
  const candidates = plan.filter((p) => p.action === "create" || p.action === "reopen");
  let diagnosed = 0;
  if (canDiagnose) {
    for (const p of candidates) {
      if (diagnosed >= maxDiagnoses) break;
      diagnosed += 1;
      p.diagnose = `d${diagnosed}`;
      writeFileSync(join(outDir, "prompts", `${p.diagnose}.md`), renderPrompt(template, p.flake, { workingDirectory }));
    }
  }

  let diagnosisNote = null;
  if (candidates.length > 0 && !canDiagnose) diagnosisNote = "skipped: no Claude token is set";
  else if (candidates.length > diagnosed) diagnosisNote = `ran for ${diagnosed} of ${candidates.length} new flakes (max-diagnoses is ${maxDiagnoses})`;

  const triage = {
    workingDirectory,
    runs,
    testCount: tests.length,
    plan: plan.map((p) => ({ flake: p.flake, action: p.action, issue: issueRef(p.issue), diagnose: p.diagnose })),
    broken,
    diagnosisNote,
  };
  writeFileSync(join(outDir, "triage.json"), JSON.stringify(triage, null, 2));

  return { flakyCount: flaky.length, brokenCount: broken.length, diagnoseCount: diagnosed };
}
