// Runs after everything else. If the main step never finished (it was
// cancelled, timed out or crashed before runAgent returned), move the
// issue from agent-working to agent-blocked and say so on it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { client } from "../lib/github.mjs";
import { installationToken } from "../lib/app-token.mjs";
import { main, mask } from "../lib/action.mjs";
import { WRITE, takeKey } from "../lib/write.mjs";
import { stopped } from "../lib/status.mjs";

main(async () => {
  const env = process.env;
  const privateKey = takeKey(env.AGENT_APP_KEY_FILE);
  if (existsSync(join(env.AGENT_STATE, "result.json"))) return;
  const repo = env.GITHUB_REPOSITORY;
  const { token } = await installationToken({ appId: env.AGENT_APP_ID, privateKey, repo, permissions: WRITE, apiUrl: env.GITHUB_API_URL });
  mask(token);
  const gh = client({ token, repo, apiUrl: env.GITHUB_API_URL });
  const n = Number(env.AGENT_ISSUE);
  const run = `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const status = join(env.AGENT_STATE, "status-comment");
  if (existsSync(status)) {
    const id = Number(readFileSync(status, "utf8"));
    try {
      await gh.editComment(id, stopped(await gh.getComment(id), run));
    } catch (err) {
      console.log(`status comment: ${err.message}`);
    }
  }
  await gh.comment(n, `**Blocked:** the agent-ready run stopped before it finished (cancelled, timed out or crashed), so nothing here is complete. [Run log](${run})`);
  await gh.removeLabel(n, "agent-working");
  await gh.addLabels(n, ["agent-blocked"]);
});
