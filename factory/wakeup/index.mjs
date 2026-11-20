import { readFileSync } from "node:fs";
import { readClient } from "../lib/github.mjs";
import { writeClient } from "../lib/github-write.mjs";
import { wakeReview } from "../lib/wakeup.mjs";
import { main, summary } from "../../agent-ready/lib/action.mjs";

main(async () => {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_API_URL: apiUrl } = process.env;
  const result = await wakeReview({ api: readClient({ token, repo, apiUrl }), write: writeClient({ token, repo, apiUrl }),
    eventName: process.env.GITHUB_EVENT_NAME, event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) });
  summary(`Factory review wake-up: ${result.status}. ${result.reason ?? `Reconcile #${result.target} on the default branch.`}`);
});
