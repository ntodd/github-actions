// What a publish phase's token may do, and how the App key is handed over.

import { readFileSync, unlinkSync } from "node:fs";

// The App has no workflows permission, so these tokens can't push changes
// to .github/workflows/. Asking for more than the App has fails, so keep
// this in step with app/create-app.mjs.
export const WRITE = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
};

// The workflow writes the key to a file in a step of its own. Read it and
// delete the file, so the key lives only in this process's memory and
// nothing Claude starts can read it from disk or the environment.
export function takeKey(file) {
  const key = readFileSync(file, "utf8");
  unlinkSync(file);
  return key;
}

// Only the workflow uses this, to rerun a flaky job. Claude never gets it:
// actions: write can also start and cancel workflows. The App needs
// Actions: Read and write for it; without that a flake ends the run blocked.
export const RERUN = { metadata: "read", actions: "write" };
