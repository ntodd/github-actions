// Fills in prompts/*.md for each phase.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export const fill = (template, vars) => template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

const quote = (s) => String(s ?? "").trim().split("\n").map((l) => `  > ${l}`).join("\n");
const none = (items, f) => (items?.length ? items.map(f).join("\n") : "None.");

export function renderer({ owner, state, bot }) {
  const cache = {};
  const load = (name) => (cache[name] ??= readFileSync(join(dir, `${name}.md`), "utf8"));

  return (phase, v) => {
    const { issue } = v;
    const vars = {
      owner,
      state,
      bot,
      repo: v.repo,
      number: issue.number,
      title: issue.title,
      body: issue.body?.trim() || "(No description.)",
      labels: (issue.labels ?? []).join(", ") || "none",
      comments: issue.comments?.length
        ? `### Comments from ${owner}\n\n${issue.comments
            .map((c) => `**${c.user.login}**, ${String(c.created_at).slice(0, 10)}:\n\n${c.body.trim()}`)
            .join("\n\n")}\n`
        : "",
      subIssues: issue.subIssues?.length ? `### Sub-issues\n\n${issue.subIssues.map((s) => `- #${s.number} ${s.title} (${s.state})`).join("\n")}\n` : "",
      round: v.round ?? 0,
      failed: none(v.failed, (f) => `- #${f.pr} ${f.name}: ${f.conclusion}${f.url ? ` (${f.url})` : ""}`),
      threads: none(
        v.threads,
        (t) => `- #${t.pr} thread ${t.id} by ${t.author} at ${t.path ?? "the PR"}${t.line ? `:${t.line}` : ""}${t.outdated ? ", outdated" : ""}${t.url ? ` (${t.url})` : ""}\n${quote(t.body)}`,
      ),
      waitingFor: v.waitingFor?.length ? `\nThese review bots didn't review in time: ${v.waitingFor.join(", ")}.\n` : "",
      status: v.status ?? "",
      reason: v.reason ? ` (${v.reason})` : "",
      prs: (v.prs ?? []).map((n) => `#${n}`).join(", ") || "none",
      rounds: v.rounds ?? 0,
    };
    const name = phase === "publish" && vars.round > 0 ? "publish-round" : phase;
    return fill(load(name), vars);
  };
}
