// The main step: wires the real GitHub, App tokens and Claude into
// runAgent, then writes the job summary.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { client } from "../lib/github.mjs";
import { installationToken, appSlug } from "../lib/app-token.mjs";
import { trustedComments, trustedSubIssues, untrustedEditor, parseRequest, parseList } from "../lib/gate.mjs";
import { prepareResolve, isStack } from "../lib/resolve.mjs";
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
  const state = env.AGENT_STATE;
  mkdirSync(state, { recursive: true });
  const privateKey = takeKey(env.AGENT_APP_KEY_FILE);
  // The PAT for screenshots, handed over the same way. Optional.
  const attachToken = existsSync(env.AGENT_ATTACH_TOKEN_FILE) ? takeKey(env.AGENT_ATTACH_TOKEN_FILE).trim() : "";
  mask(attachToken);
  const appId = env.AGENT_APP_ID;

  // The gate read the mode from the same payload with the same parser.
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const request = parseRequest(env.GITHUB_EVENT_NAME, event.inputs);
  if (request.error) throw new Error(request.error);

  const trustedUsers = parseList(env.AGENT_TRUSTED_USERS);
  const read = client({ token: env.GITHUB_TOKEN, repo, apiUrl });
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
  const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

  // What the run works and where it reports: the issue, or for a resolve
  // run on a trusted user's own PR, the PR itself.
  let number = Number(env.AGENT_ISSUE);
  let issue;
  let resolve = null;
  if (request.mode === "resolve") {
    // The gate ran these checks without the App's login. This is the full
    // set, before Claude does anything.
    const prep = await prepareResolve({ request, sender: event.sender, github: read, repo, label: env.AGENT_LABEL, trustedUsers, appBot: bot, clock });
    if (!prep.go) {
      // Nothing to do, or not allowed. Either way the issue and its labels
      // stay as they are, and result.json tells cleanup.mjs the run ended.
      const res = { status: "skipped", reason: prep.reason, prs: [], rounds: 0, report: "", phases: [] };
      writeFileSync(join(state, "result.json"), JSON.stringify(res, null, 2));
      summary(`agent-ready didn't resolve #${request.pr}: ${prep.reason}.`);
      console.log(`Not resolving #${request.pr}: ${prep.reason}.`);
      setOutput("status", res.status);
      setOutput("prs", "");
      if (prep.refused) process.exitCode = 1;
      return;
    }
    const { pr } = prep;
    const own = prep.kind === "own";
    number = own ? pr.number : prep.issue.number;
    resolve = { pr: pr.number, own, stack: isStack(pr, await read.openPulls()), headRef: pr.headRef, baseRef: pr.baseRef, headSha: pr.headSha };
    issue = own
      ? { number, title: pr.title, body: pr.body, labels: pr.labels, comments: [], subIssues: [], author: pr.author }
      : {
          number,
          title: prep.issue.title,
          body: prep.issue.body ?? "",
          labels: (prep.issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
          comments: trustedComments(await read.comments(number), trustedUsers),
          subIssues: [],
          author: prep.issue.user?.login,
        };
  } else {
    const raw = await read.issue(number);
    // The gate checked this before setup. Check again, now that it's read.
    const editor = untrustedEditor({ ...raw, editors: await read.editors(number) }, trustedUsers);
    if (editor) throw new Error(`${editor} edited #${number} after the gate checked it, and isn't trusted`);
    issue = {
      number,
      title: raw.title,
      body: raw.body ?? "",
      labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
      comments: trustedComments(await read.comments(number), trustedUsers),
      subIssues: trustedSubIssues(await read.subIssues(number), trustedUsers),
      author: raw.user?.login,
    };
  }

  // Commits are the App bot's unless the caller named an author.
  const gitGet = (key) => spawnSync("git", ["config", "--global", key], { encoding: "utf8" }).stdout.trim();
  if (!gitGet("user.name")) spawnSync("git", ["config", "--global", "user.name", bot]);
  if (!gitGet("user.email")) {
    const { id } = await read.user(bot);
    spawnSync("git", ["config", "--global", "user.email", `${id}+${bot}@users.noreply.github.com`]);
  }

  const render = renderer({ owner: trustedUsers[0], state, bot });
  const systemPromptFile = join(state, "system.md");
  writeFileSync(systemPromptFile, render("system", { repo, issue, resolve }));

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
    resolve,
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
      appBot: bot,
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
    clock,
    log,
  });

  writeFileSync(join(state, "result.json"), JSON.stringify(res, null, 2));
  const server = env.GITHUB_SERVER_URL;
  const cost = res.phases.reduce((a, p) => a + (p.cost ?? 0), 0);
  summary(
    [
      `## agent-ready${resolve ? " (resolve)" : ""}: #${number} ${issue.title}`,
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
  if (res.status !== "done" && res.status !== "covered") process.exitCode = 1;
});
