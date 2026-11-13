import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectValues, projectProcessEnvironment } from "./project-environment.mjs";
import { workerMeter } from "./usage.mjs";

// Preparation can ask a question before the project has even been checked out.
// This artifact has no commits or API effects and uses the normal owner checks.
export function preparationOutcome({ assignment, run, resultDir, outcome, reason }) {
  const op = assignment.operation;
  if (!["needs-you", "failed"].includes(outcome) || op.phase !== "claimed" || op.owner?.id !== run.id || op.owner?.attempt !== run.attempt
    || typeof reason !== "string" || !reason.trim() || reason.length > 2000) throw new Error("Invalid preparation outcome");
  mkdirSync(resultDir, { recursive: true, mode: 0o700 });
  const proposal = { schemaVersion: 1, operationId: op.id, run: { id: run.id, attempt: run.attempt }, outcome, reason, effects: [],
    report: "Project preparation ended before model work.", tests: [], metrics: { ...workerMeter().snapshot(), cliVersion: null } };
  writeFileSync(join(resultDir, "proposal.json"), JSON.stringify(proposal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return proposal;
}

export async function runProjectSetup({ config, secrets, cwd, readToken, env = process.env,
  timeoutMs = config.timeouts.workerMinutes * 60000, spawn = nodeSpawn }) {
  const environment = projectProcessEnvironment(env, readToken, projectValues(config.environment, secrets, "setup"), "setup");
  if (!config.setup.trim()) return { status: "ready" };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Project setup needs a bounded execution deadline");
  return new Promise((resolve) => {
    let settled = false, timedOut = false, timer, force;
    const finish = (success) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(force);
      resolve(success ? { status: "ready" } : { status: "failed", reason: timedOut
        ? "Project setup exceeded its execution deadline; inspect the Actions log"
        : "Project setup failed before model work; inspect the Actions log" });
    };
    let child;
    try { child = spawn("/bin/bash", ["-euo", "pipefail", "-c", config.setup], { cwd, env: environment, stdio: "inherit", detached: true }); }
    catch { finish(false); return; }
    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already terminal. */ }
      force = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already terminal. */ }
        finish(false);
      }, 1000);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("close", (code) => { if (!timedOut) finish(code === 0); });
  });
}
