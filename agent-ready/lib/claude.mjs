// Runs one phase of the session with the Claude Code CLI. The first phase
// starts the session with a known ID and later phases resume it, so Claude
// keeps its context across rounds. Each phase gets its own GH_TOKEN, and
// none of them get the job's GITHUB_TOKEN or the App key.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Variables Claude's environment never gets.
const WITHHELD = [
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^AGENT_APP_/,
  /^ACTIONS_RUNTIME_TOKEN$/,
  /^ACTIONS_ID_TOKEN_REQUEST_/,
  /^ACTIONS_CACHE_URL$/,
  /^ACTIONS_RESULTS_URL$/,
  /^INPUT_/,
];

const MISSING = "You ended the phase without writing outcome.json. Write it now, exactly as the phase asked, and stop.";

export function claudeRunner({ bin = "claude", sessionId, stateDir, cwd, model, effort, maxTurns, systemPromptFile, mcpConfig, env, timeoutMs, spawn = nodeSpawn, log }) {
  let started = false;
  // A resumed session's result reports the session's running cost.
  let spent = 0;
  const base = Object.fromEntries(Object.entries(env).filter(([k]) => !WITHHELD.some((re) => re.test(k))));
  const files = { outcome: join(stateDir, "outcome.json"), comment: join(stateDir, "comment.md"), report: join(stateDir, "report.md") };

  const invoke = (prompt, token, phase, limit) =>
    new Promise((resolve, reject) => {
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
      args.push("--model", model, "--effort", effort, "--max-turns", String(maxTurns));
      if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
      if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
      args.push(...(started ? ["--resume", sessionId] : ["--session-id", sessionId]));
      started = true;

      const child = spawn(bin, args, {
        cwd,
        env: { ...base, GH_TOKEN: token, AGENT_STATE: stateDir, AGENT_PHASE: phase },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let result = null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, limit);
      createInterface({ input: child.stdout }).on("line", (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "result") result = ev;
        const out = streamLine(ev);
        if (out) log(out);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`${phase}: timed out after ${Math.round(limit / 60_000)} minutes`));
        resolve({ code, result });
      });
    });

  const read = () => {
    if (!existsSync(files.outcome)) return null;
    let outcome;
    try {
      outcome = JSON.parse(readFileSync(files.outcome, "utf8"));
    } catch {
      return null;
    }
    for (const k of ["comment", "report"]) {
      if (existsSync(files[k])) outcome[k] ??= readFileSync(files[k], "utf8").trim();
    }
    return outcome;
  };

  return async ({ phase, token, prompt, timeoutMs: limit = timeoutMs }) => {
    mkdirSync(stateDir, { recursive: true });
    for (const f of Object.values(files)) rmSync(f, { force: true });

    let turns = 0;
    let cost = 0;
    const once = async (p) => {
      const { result } = await invoke(p, token, phase, limit);
      turns += result?.num_turns ?? 0;
      const total = result?.total_cost_usd ?? 0;
      cost += total >= spent ? total - spent : total;
      spent = Math.max(spent, total);
      return result;
    };

    let result = await once(prompt);
    let outcome = read();
    if (!outcome) {
      log(`${phase}: no outcome.json, asking for it`);
      result = await once(MISSING);
      outcome = read();
    }
    if (!outcome) throw new Error(`${phase}: no outcome.json (${result?.subtype ?? "no result"})`);
    return { outcome, turns, cost };
  };
}

const oneLine = (s, n = 240) => {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

// A short line for the job log, or null for events not worth one.
export function streamLine(ev) {
  if (ev.type === "result") {
    return `result: ${ev.subtype} after ${ev.num_turns} turns, $${Number(ev.total_cost_usd ?? 0).toFixed(2)}`;
  }
  if (ev.type !== "assistant") return null;
  const parts = [];
  for (const c of ev.message?.content ?? []) {
    if (c.type === "text" && c.text.trim()) parts.push(oneLine(c.text));
    if (c.type === "tool_use") {
      const i = c.input ?? {};
      const detail = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? i.skill ?? "";
      parts.push(`→ ${c.name}${detail ? `: ${oneLine(detail, 200)}` : ""}`);
    }
  }
  return parts.length ? parts.join("\n") : null;
}
