import { readFileSync } from "node:fs";
import { input, main, setOutput } from "../lib/action.mjs";
import { client } from "../lib/github.mjs";
import { runTriage } from "../lib/triage.mjs";

main(async () => {
  const maxDiagnoses = Number.parseInt(input("max-diagnoses", "3"), 10);
  if (!Number.isInteger(maxDiagnoses) || maxDiagnoses < 0) throw new Error("max-diagnoses must be a whole number");

  const result = await runTriage({
    resultsDir: input("results"),
    outDir: input("out"),
    workingDirectory: input("working-directory", "."),
    label: input("label", "flaky-test"),
    maxDiagnoses,
    canDiagnose: input("can-diagnose", "false") === "true",
    gh: client({ token: input("token"), repo: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL }),
    template: readFileSync(new URL("../prompts/diagnose.md", import.meta.url), "utf8"),
  });

  console.log(`${result.flakyCount} flaky, ${result.brokenCount} broken, ${result.diagnoseCount} to diagnose`);
  setOutput("flaky-count", result.flakyCount);
  setOutput("broken-count", result.brokenCount);
  setOutput("diagnose-count", result.diagnoseCount);
});
