import { currentWorker } from "./context.mjs";
import { writeProjectEnvironment, ProjectEnvironmentError } from "../lib/project-environment.mjs";
import { preparationOutcome } from "../lib/project-setup.mjs";
import { main } from "../../agent-ready/lib/action.mjs";

main(async () => {
  const context = await currentWorker();
  try { writeProjectEnvironment({ path: context.environmentFile, assignment: context.assignment, run: context.run, text: process.env.FACTORY_PROJECT_SECRETS }); }
  catch (error) {
    if (error instanceof ProjectEnvironmentError) preparationOutcome({ ...context, outcome: "needs-you", reason: error.message });
    throw error;
  } finally { delete process.env.FACTORY_PROJECT_SECRETS; }
});
