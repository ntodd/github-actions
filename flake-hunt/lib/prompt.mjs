// Fills prompts/diagnose.md for one flake. Unknown {{names}} are left alone.

import { normalizeDir } from "./aggregate.mjs";
import { displayName } from "./issues.mjs";

const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 3000;

function messages(flake) {
  const seen = new Set();
  const out = [];
  for (const r of flake.failedRuns) {
    const msg = (r.message ?? "").trim();
    if (seen.has(msg)) continue;
    seen.add(msg);
    out.push(`Seed ${r.seed}:\n${msg.slice(0, MAX_MESSAGE_CHARS) || "(no message)"}`);
    if (out.length === MAX_MESSAGES) break;
  }
  return out.join("\n\n---\n\n");
}

export function renderPrompt(template, flake, ctx) {
  const vars = {
    test: `${flake.module} "${displayName(flake.name)}"`,
    module: flake.module,
    name: flake.name,
    file: flake.file,
    line: flake.line,
    runs: flake.runs,
    failures: flake.failures,
    seeds: flake.failedRuns.map((r) => r.seed).join(", "),
    first_seed: flake.failedRuns[0]?.seed ?? "",
    working_directory: normalizeDir(ctx.workingDirectory) || ".",
    failures_block: messages(flake),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
