import { input, main } from "../lib/action.mjs";
import { client } from "../lib/github.mjs";
import { runReport } from "../lib/report.mjs";

main(async () => {
  const { GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL: serverUrl, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  const gh = client({ token: input("token"), repo, apiUrl: process.env.GITHUB_API_URL });

  const mode = input("dry-run", "auto");
  if (!["auto", "always", "never"].includes(mode)) throw new Error(`dry-run must be auto, always or never, not ${mode}`);
  let dryRun = mode === "always";
  if (mode === "auto") {
    const branch = await gh.defaultBranch();
    dryRun = process.env.GITHUB_REF !== `refs/heads/${branch}`;
    if (dryRun) console.log(`Dry run: ${process.env.GITHUB_REF} isn't ${branch}.`);
  }

  const runUrl = `${serverUrl}/${repo}/actions/runs/${runId}${attempt && attempt !== "1" ? `/attempts/${attempt}` : ""}`;
  await runReport({
    triageDir: input("triage"),
    diagnosesDir: input("diagnoses"),
    label: input("label", "flaky-test"),
    dryRun,
    gh,
    ctx: { repo, sha: process.env.GITHUB_SHA, serverUrl, runUrl },
    summaryFile: process.env.GITHUB_STEP_SUMMARY,
  });
});
