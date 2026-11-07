// The status comment: one comment on the issue, posted when the run starts
// and edited as it goes, so the issue shows what the agent is doing without
// a notification for every step. Edits never throw; a status comment that
// can't be written shouldn't stop the run.

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));

const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g;

// Claude's words go on the issue, so keep them to one short line, with no
// mentions that would ping anyone and nothing that looks like a token.
export function clean(text, max = 200) {
  const flat = String(text).replace(SECRET, "[redacted]").replace(/@(?=[A-Za-z0-9])/g, "@\u200b").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// What a stream event says Claude is doing: the todo it's on, or the first
// line of what it just said. Tool calls alone aren't worth showing.
export function progressNote(ev) {
  if (ev?.type !== "assistant") return null;
  let note = null;
  for (const c of ev.message?.content ?? []) {
    if (c.type === "tool_use" && c.name === "TodoWrite" && Array.isArray(c.input?.todos)) {
      const todos = c.input.todos;
      const i = todos.findIndex((t) => t.status === "in_progress");
      if (i >= 0) note = `${todos[i].activeForm || todos[i].content} (${i + 1} of ${todos.length})`;
    } else if (c.type === "text" && !note) {
      note = c.text.split("\n").find((l) => l.trim())?.trim() ?? null;
    }
  }
  return note;
}

export function tracker({ post, edit, clock, everyMs = 5 * 60_000, runUrl = "", log = () => {}, onPost = () => {} }) {
  const steps = [];
  let headline = null;
  let now = null;
  let id = null;
  let flushedAt = -Infinity;
  let chain = Promise.resolve();

  const render = () => {
    const t = clock.now();
    const run = runUrl ? ` [Run log](${runUrl})` : "";
    const top = headline ?? `**agent-ready is working on this.** Started ${hhmm(steps[0]?.start ?? t)} UTC.`;
    const lines = steps.map((s) => (s.end != null ? `- [x] ${s.label} (${minutes(s.end - s.start)} min)` : `- [ ] ${s.label} (${minutes(t - s.start)} min so far)`));
    return [`${top}${run}`, lines.join("\n"), now ? `Now (${hhmm(now.at)} UTC): ${now.text}` : ""].filter(Boolean).join("\n\n");
  };

  const flush = () => {
    flushedAt = clock.now();
    const body = render();
    chain = chain.then(async () => {
      try {
        if (id == null) {
          id = await post(body);
          onPost(id);
        } else await edit(id, body);
      } catch (err) {
        log(`status comment: ${err.message}`);
      }
    });
    return chain;
  };

  const close = () => {
    const last = steps.at(-1);
    if (last && last.end == null) last.end = clock.now();
  };

  return {
    step(label) {
      close();
      steps.push({ label, start: clock.now() });
      now = null;
      return flush();
    },
    note(text) {
      const c = text && clean(text);
      if (c) now = { text: c, at: clock.now() };
      return clock.now() - flushedAt >= everyMs ? flush() : chain;
    },
    finish(text) {
      close();
      headline = text;
      now = null;
      return flush();
    },
    commentId: () => id,
  };
}

// A tracker that does nothing, for runs without an issue to write to.
export const silent = { step: async () => {}, note: async () => {}, finish: async () => {}, commentId: () => null };

// For the cleanup step, when the job died mid-run: the steps stay, and the
// headline says it stopped.
export function stopped(body, runUrl) {
  const rest = String(body).split("\n\n").slice(1).join("\n\n");
  const top = `**agent-ready stopped before it finished.** The job was cancelled, timed out or crashed.${runUrl ? ` [Run log](${runUrl})` : ""}`;
  return [top, rest].filter(Boolean).join("\n\n");
}
