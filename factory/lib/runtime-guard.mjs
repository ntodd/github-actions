// Migration is a runtime precondition too. Never infer that disabling the old
// workflow terminated its queued, approval-waiting or executing runs.
import { parseDocument } from "../vendor/yaml.mjs";
export const LEGACY_WORKFLOW = ".github/workflows/agent-ready.yml";
export const LIVE_RUN_STATUSES = ["queued", "in_progress", "requested", "waiting", "pending"];
const disabled = new Set(["disabled_manually", "disabled_inactivity", "disabled_fork", "deleted"]);
export class RuntimeConflict extends Error {
  constructor(message) { super(message); this.name = "RuntimeConflict"; this.code = "runtime-conflict"; }
}
export async function assertRuntimeIsolation(api) {
  const rows = await api.workflows();
  if (!Array.isArray(rows) || rows.some((w) => !Number.isSafeInteger(w.id) || w.id < 1 || typeof w.path !== "string"
    || typeof w.state !== "string") || new Set(rows.map((w) => w.id)).size !== rows.length) throw new RuntimeConflict("Workflow inventory is incomplete; factory execution is withheld");
  const entries = rows.filter((w) => w.path === LEGACY_WORKFLOW);
  const others = rows.filter((w) => w.path !== LEGACY_WORKFLOW && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(w.path));
  if (others.length) {
    const repository = await api.repository(), sha = await api.branchSha(repository.default_branch);
    for (const workflow of others) {
      const file = await api.fileAt(workflow.path, sha);
      const document = parseDocument(typeof file === "string" ? file : file.content);
      if (document.errors.length) throw new RuntimeConflict(`Cannot inspect ${workflow.path}; fix its YAML before factory execution`);
      if (Object.values(document.toJS()?.jobs ?? {}).some((job) => typeof job?.uses === "string"
        && /(?:^|\/)\.github\/workflows\/agent-ready\.yml(?:@|$)/.test(job.uses))) entries.push(workflow);
    }
  }
  for (const workflow of entries) {
    if (!disabled.has(workflow.state)) throw new RuntimeConflict(`The legacy agent-ready workflow ${workflow.path} is active or unknown; disable it and observe its runs before factory execution`);
    const live = await api.liveWorkflowRuns(workflow.id);
    if (!Array.isArray(live) || live.length) throw new RuntimeConflict("The legacy agent-ready workflow still has live or unobserved runs; factory execution is withheld");
  }
}
