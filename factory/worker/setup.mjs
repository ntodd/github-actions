import { currentWorker } from "./context.mjs";
import { readProjectEnvironment, ProjectEnvironmentError } from "../lib/project-environment.mjs";
import { runProjectSetup, preparationOutcome } from "../lib/project-setup.mjs";
import { main } from "../../agent-ready/lib/action.mjs";

main(async () => {
  const context = await currentWorker({ checkout: true });
  let result;
  try {
    const secrets = readProjectEnvironment({ path: context.environmentFile, assignment: context.assignment, run: context.run });
    result = await runProjectSetup({ ...context, config: context.assignment.config, secrets });
  } catch (error) {
    if (error instanceof ProjectEnvironmentError) preparationOutcome({ ...context, outcome: "needs-you", reason: error.message });
    throw error;
  }
  if (result.status === "failed") {
    preparationOutcome({ ...context, outcome: "failed", reason: result.reason });
    throw new Error(result.reason);
  }
});
