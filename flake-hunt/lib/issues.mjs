// Matching flakes to issues, and the markdown for issues, comments and the
// job summary.

import { normalizeDir } from "./aggregate.mjs";

const MARKER = /<!-- flake-hunt:(\S+) -->/;
const MAX_MESSAGES = 3;
const MAX_SEEDS = 20;

export function markerFor(key) {
  return `<!-- flake-hunt:${encodeURIComponent(key)} -->`;
}

export function keyFromBody(body) {
  const m = MARKER.exec(body ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

// One plan entry per flake:
//   create  - no issue has ever tracked it
//   comment - an open issue tracks it
//   reopen  - the latest issue was closed as completed, and it flaked again
//   skip    - the latest issue was closed as not planned: someone chose to ignore it
export function planIssues(flaky, issues) {
  const byKey = new Map();
  for (const issue of issues) {
    const key = keyFromBody(issue.body);
    if (key === null) continue;
    const list = byKey.get(key) ?? [];
    list.push(issue);
    byKey.set(key, list);
  }

  return flaky.map((flake) => {
    const list = byKey.get(flake.key) ?? [];
    const open = list.find((i) => i.state === "open");
    if (open) return { flake, action: "comment", issue: open };
    const latest = [...list].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    if (!latest) return { flake, action: "create", issue: null };
    if (latest.state_reason === "not_planned") return { flake, action: "skip", issue: latest };
    return { flake, action: "reopen", issue: latest };
  });
}

export function displayName(name) {
  return name.replace(/^test /, "");
}

export function titleFor(flake, workingDirectory) {
  const dir = normalizeDir(workingDirectory);
  const prefix = dir ? `[${dir}] ` : "";
  const title = `${prefix}Flaky test: ${flake.module} "${displayName(flake.name)}"`;
  return title.length <= 256 ? title : `${title.slice(0, 252)}..."`;
}

function percent(f) {
  const p = (100 * f.failures) / f.runs;
  return p >= 1 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

function repoPath(workingDirectory, file) {
  const dir = normalizeDir(workingDirectory);
  return dir ? `${dir}/${file}` : file;
}

function testLink(flake, ctx) {
  const path = repoPath(ctx.workingDirectory, flake.file);
  const url = `${ctx.serverUrl}/${ctx.repo}/blob/${ctx.sha}/${path}#L${flake.line}`;
  return `[\`${flake.file}:${flake.line}\`](${url})`;
}

function fence(text, lang = "") {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function rateLine(flake, ctx) {
  return `Failed **${flake.failures} of ${flake.runs}** runs (${percent(flake)}) on \`${ctx.sha.slice(0, 7)}\` ([hunt run](${ctx.runUrl})).`;
}

function seedsLine(flake) {
  const seeds = flake.failedRuns.map((r) => r.seed);
  const shown = seeds.slice(0, MAX_SEEDS).join(", ");
  const more = seeds.length > MAX_SEEDS ? `, and ${seeds.length - MAX_SEEDS} more` : "";
  return `Failing seeds: ${shown}${more}.`;
}

function reproBlock(flake, ctx) {
  const dir = normalizeDir(ctx.workingDirectory);
  const seed = flake.failedRuns[0]?.seed;
  const lines = [];
  if (dir) lines.push(`cd ${dir}`);
  lines.push(`# The whole suite with a seed that failed (order-dependent flakes need this)`);
  lines.push(`mix test --seed ${seed}`);
  lines.push(`# The test alone, until it fails`);
  lines.push(`mix test ${flake.file}:${flake.line} --repeat-until-failure 500`);
  return fence(lines.join("\n"), "sh");
}

function failuresBlock(flake) {
  const seen = new Set();
  const parts = [];
  for (const r of flake.failedRuns) {
    const msg = (r.message ?? "").trim();
    if (seen.has(msg)) continue;
    seen.add(msg);
    if (parts.length === MAX_MESSAGES) break;
    parts.push(`<details><summary>Seed ${r.seed} (shard ${r.shard}, run ${r.run})</summary>\n\n${fence(msg || "(no message)")}\n\n</details>`);
  }
  return parts.join("\n\n");
}

function diagnosisBlock(diagnosis) {
  if (!diagnosis) return null;
  return `### Diagnosis\n\n_Written by Claude from the failures above, and from rerunning the test. Check it before acting on it._\n\n${diagnosis.trim()}`;
}

export function renderIssue(flake, ctx, diagnosis) {
  const sections = [
    `${testLink(flake, ctx)} · \`${flake.module}\``,
    `${rateLine(flake, ctx)} ${seedsLine(flake)}`,
    `### Reproduce\n\n${reproBlock(flake, ctx)}`,
    `### Failures\n\n${failuresBlock(flake)}`,
    diagnosisBlock(diagnosis),
    `---\n_Filed by [flake-hunt](https://github.com/ntodd/github-actions/tree/main/flake-hunt). Close it as **not planned** to stop tracking this test, or as **completed** once it's fixed: it reopens if the test flakes again._`,
    markerFor(flake.key),
  ];
  return sections.filter(Boolean).join("\n\n") + "\n";
}

export function renderComment(flake, ctx, { reopened, diagnosis }) {
  const lead = reopened ? "Flaky again after this was closed." : "Still flaky.";
  return (
    [
      `${lead} ${rateLine(flake, ctx)} ${seedsLine(flake)}`,
      failuresBlock(flake),
      diagnosisBlock(diagnosis),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

function did(result, dryRun) {
  const n = result.issue?.number;
  switch (result.action) {
    case "create":
      return dryRun ? "would open an issue" : `opened #${n}`;
    case "comment":
      return dryRun ? `would comment on #${n}` : `commented on #${n}`;
    case "reopen":
      return dryRun ? `would reopen #${n}` : `reopened #${n}`;
    case "skip":
      return `ignored: #${n} was closed as not planned`;
    default:
      return result.action;
  }
}

function outcome(result, dryRun) {
  if (result.error) return result.done ? `${did(result, dryRun)}, but ${result.error}` : `failed: ${result.error}`;
  if (!result.agent) return did(result, dryRun);
  return `${did(result, dryRun)} and ${dryRun ? "start" : "started"} ${result.agent}`;
}

function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderSummary({ workingDirectory, runs, testCount, dryRun, diagnosis, results, broken }) {
  const dir = normalizeDir(workingDirectory) || "(root)";
  const lines = [`## Flake hunt: ${dir}`, ""];
  if (dryRun) lines.push("**Dry run:** no issues were filed or changed.", "");
  lines.push(`${testCount} ${testCount === 1 ? "test" : "tests"}, ${runs.reported} of ${runs.total} runs reported results.`);
  if (runs.errored > 0) lines.push(`${runs.errored} ${runs.errored === 1 ? "run" : "runs"} reported nothing: check the hunt logs for a crash or a compile error.`);
  if (diagnosis) lines.push(`Diagnosis ${diagnosis}.`);
  lines.push("");

  if (results.length === 0) {
    lines.push("No flaky tests.");
  } else {
    lines.push("| Test | Failed | Outcome |", "|---|---|---|");
    for (const r of results) {
      const f = r.flake;
      lines.push(`| ${cell(`${f.module} "${displayName(f.name)}"`)} | ${f.failures}/${f.runs} | ${cell(outcome(r, dryRun))} |`);
    }
  }

  if (broken.length > 0) {
    lines.push("", "### Failed every run", "", "Not filed: a test that always fails is broken, which CI should catch. If CI is green, it may need something these VMs lack.", "");
    for (const f of broken) lines.push(`- ${f.module} "${displayName(f.name)}" (${f.file}:${f.line})`);
  }

  return lines.join("\n") + "\n";
}
