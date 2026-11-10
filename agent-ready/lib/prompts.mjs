// Fills in prompts/*.md for each phase.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

const SECTION = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;

// {{name}} becomes vars.name. {{#name}}...{{/name}} stays when vars.name is
// set and {{^name}}...{{/name}} when it isn't, so one prompt file can hold
// what differs between a build run and a resolve run. Sections are worked
// out on the template alone, before any value goes in, so nothing in an
// issue's text is ever read as one.
export function fill(template, vars) {
  let text = template;
  for (let prev; prev !== text; ) {
    prev = text;
    text = text.replace(SECTION, (m, kind, k, inner) => ((kind === "#") === Boolean(vars[k]) ? inner : ""));
  }
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const quote = (s) => String(s ?? "").trim().split("\n").map((l) => `  > ${l}`).join("\n");
const none = (items, f) => (items?.length ? items.map(f).join("\n") : "None.");

export function renderer({ owner, state, bot }) {
  const cache = {};
  const load = (name) => (cache[name] ??= readFileSync(join(dir, `${name}.md`), "utf8"));

  return (phase, v) => {
    const { issue } = v;
    // A resolve run's PR (run.mjs's resolve), or nothing for a build.
    const rz = v.resolve ?? null;
    const round = v.round ?? 0;
    const vars = {
      resolve: Boolean(rz),
      own: Boolean(rz?.own),
      again: Boolean(rz) && round > 0,
      pr: rz?.pr ?? "",
      headRef: rz?.headRef ?? "",
      baseRef: rz?.baseRef ?? "",
      headSha: v.headSha ?? rz?.headSha ?? "",
      baseSha: v.baseSha ?? "",
      author: issue.author ?? owner,
      // A trusted user's own PR has no issue behind it.
      subject: rz?.own ? `pull request #${issue.number}` : `issue #${issue.number}`,
      roundSuffix: round > 0 ? `, round ${round}` : "",
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
      round,
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
    // A resolve run never opens a PR, so even its first publish is a round's.
    const name = phase === "publish" && (round > 0 || rz) ? "publish-round" : phase;
    return fill(load(name), vars);
  };
}
