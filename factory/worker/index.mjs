import { currentWorker } from "./context.mjs";
import { readProjectEnvironment, ProjectEnvironmentError } from "../lib/project-environment.mjs";
import { preparationOutcome } from "../lib/project-setup.mjs";
import { runWorker } from "../lib/worker.mjs";
import { gitCommand } from "../lib/git.mjs";
import { main, summary, setOutput } from "../../agent-ready/lib/action.mjs";

main(async () => {
  const env = process.env, loaded = await currentWorker({ checkout: true }), { cwd } = loaded;
  let projectSecrets;
  try { projectSecrets = readProjectEnvironment({ path: loaded.environmentFile, assignment: loaded.assignment, run: loaded.run }); }
  catch (error) {
    if (error instanceof ProjectEnvironmentError) preparationOutcome({ ...loaded, outcome: "needs-you", reason: error.message });
    throw error;
  }
  gitCommand(cwd, ["config", "user.name", loaded.assignment.config.worker.gitName]);
  gitCommand(cwd, ["config", "user.email", loaded.assignment.config.worker.gitEmail]);
  if (env.FACTORY_MCP_CONFIG) loaded.assignment.mcpConfig = env.FACTORY_MCP_CONFIG;
  const result = await runWorker({ ...loaded, cwd, stateDir: env.FACTORY_STATE_DIR,
    projectSecrets });
  setOutput("outcome", result.outcome);
  summary(`Factory ${loaded.assignment.operation.mode}: ${result.outcome}.\n\n${result.reason || "Proposal prepared for the trusted publisher."}`);
});
