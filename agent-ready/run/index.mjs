// The main step: wires the real GitHub, App tokens and Claude into
// runAgent, then writes the job summary.

import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { client } from "../lib/github.mjs";
import { installationToken, appSlug } from "../lib/app-token.mjs";
import { trustedComments, trustedSubIssues, untrustedEditor, parseList } from "../lib/gate.mjs";
import { claudeRunner } from "../lib/claude.mjs";
import { renderer } from "../lib/prompts.mjs";
import { runAgent } from "../lib/run.mjs";
import { main, mask, setOutput, summary } from "../lib/action.mjs";
import { WRITE, RERUN, takeKey } from "../lib/write.mjs";
import { attacher } from "../lib/attach.mjs";
import { tracker, progressNote } from "../lib/status.mjs";
import { existsSync } from "node:fs";

main(async () => {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  const apiUrl = env.GITHUB_API_URL;
  const number = Number(env.AGENT_ISSUE);
  const state = env.AGENT_STATE;
  mkdirSync(state, { recursive: true });

  const privateKey = takeKey(env.AGENT_APP_KEY_FILE);
  // The PAT for screenshots, handed over the same way. Optional.
  const attachToken = existsSync(env.AGENT_ATTACH_TOKEN_FILE) ? takeKey(env.AGENT_ATTACH_TOKEN_FILE).trim() : "";
  mask(attachToken);
  const appId = env.AGENT_APP_ID;

  const trustedUsers = parseList(env.AGENT_TRUSTED_USERS);
  const read = client({ token: env.GITHUB_TOKEN, repo, apiUrl });
  const raw = await read.issue(number);
  // The gate checked this before setup. Check again, now that it's read.
  const editor = untrustedEditor({ ...raw, editors: await read.editors(number) }, trustedUsers);
  if (editor) throw new Error(`${editor} edited #${number} after the gate checked it, and isn't trusted`);
  const issue = {
    number,
    title: raw.title,
    body: raw.body ?? "",
    labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    comments: trustedComments(await read.comments(number), trustedUsers),
    subIssues: trustedSubIssues(await read.subIssues(number), trustedUsers),
    author: raw.user?.login,
  };

  const mintWith = async (permissions) => {
    const { token } = await installationToken({ appId, privateKey, repo, permissions, apiUrl });
    mask(token);
    return token;
  };
  const mint = () => mintWith(WRITE);
  const writer = (token) => client({ token, repo, apiUrl });
  const runUrl = `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const slug = await appSlug({ appId, privateKey, apiUrl });
  const bot = `${slug}[bot]`;

  // Commits are the App bot's unless the caller named an author.
  const gitGet = (key) => spawnSync("git", ["config", "--global", key], { encoding: "utf8" }).stdout.trim();
  if (!gitGet("user.name")) spawnSync("git", ["config", "--global", "user.name", bot]);
  if (!gitGet("user.email")) {
    const { id } = await read.user(bot);
    spawnSync("git", ["config", "--global", "user.email", `${id}+${bot}@users.noreply.github.com`]);
  }

  const render = renderer({ owner: trustedUsers[0], state, bot });
  const systemPromptFile = join(state, "system.md");
  writeFileSync(systemPromptFile, render("system", { repo, issue }));

  const log = (line) => console.log(line);
  // The status comment on the issue. cleanup.mjs finds it by this file if
  // the job dies before the run ends.
  const progress = tracker({
    post: async (body) => writer(await mint()).comment(number, body),
    edit: async (id, body) => writer(await mint()).editComment(id, body),
    clock: { now: () => Date.now() },
    runUrl,
    log,
    onPost: (id) => writeFileSync(join(state, "status-comment"), String(id)),
  });
  const claude = claudeRunner({
    sessionId: randomUUID(),
    stateDir: state,
    cwd: env.GITHUB_WORKSPACE,
    model: env.AGENT_MODEL,
    effort: env.AGENT_EFFORT,
    maxTurns: Number(env.AGENT_MAX_TURNS),
    systemPromptFile,
    mcpConfig: env.AGENT_MCP_CONFIG || undefined,
    env,
    timeoutMs: Number(env.AGENT_PHASE_TIMEOUT_MINUTES) * 60_000,
    log,
    onEvent: (ev) => {
      const note = progressNote(ev);
      if (note) progress.note(note);
    },
  });

  const res = await runAgent({
    repo,
    issue,
    config: {
      label: env.AGENT_LABEL,
      trustedUsers,
      bots: parseList(env.AGENT_REVIEW_BOTS),
      maxRounds: Number(env.AGENT_MAX_ROUNDS),
      readyForBots: env.AGENT_READY_FOR_BOTS === "true",
      checksGraceMs: 3 * 60_000,
      reviewTimeoutMs: Number(env.AGENT_REVIEW_TIMEOUT_MINUTES) * 60_000,
      pollMs: 30_000,
      reviewers: parseList(env.AGENT_REVIEWERS),
      runUrl,
    },
    readToken: env.GITHUB_TOKEN,
    github: read,
    mint,
    writer,
    claude,
    attach: attacher({ token: attachToken, stateDir: state, repo, read, writer, mint, log }),
    rerun: async (runs) => {
      const w = writer(await mintWith(RERUN));
      for (const run of runs) await w.rerunFailedJobs(run);
    },
    progress,
    render,
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    log,
  });

  writeFileSync(join(state, "result.json"), JSON.stringify(res, null, 2));
  const server = env.GITHUB_SERVER_URL;
  const cost = res.phases.reduce((a, p) => a + (p.cost ?? 0), 0);
  summary(
    [
      `## agent-ready: #${number} ${issue.title}`,
      "",
      `**${res.status}**${res.reason ? `: ${res.reason}` : ""}. ${env.AGENT_MODEL} at ${env.AGENT_EFFORT} effort, ${res.rounds} review round${res.rounds === 1 ? "" : "s"}, $${cost.toFixed(2)}.`,
      "",
      res.prs.length ? `Pull requests: ${res.prs.map((n) => `[#${n}](${server}/${repo}/pull/${n})`).join(", ")}` : "No pull requests.",
      "",
      "| Phase | Outcome | Turns | Cost |",
      "|---|---|---|---|",
      ...res.phases.map((p) => `| ${p.phase} | ${p.status ?? ""} | ${p.turns ?? ""} | $${(p.cost ?? 0).toFixed(2)} |`),
      "",
      res.report || "",
    ].join("\n"),
  );
  setOutput("status", res.status);
  setOutput("prs", res.prs.join(" "));
  if (res.status !== "done") process.exitCode = 1;
});
