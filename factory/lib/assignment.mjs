import { parseConfig, loadConfig, withFactoryApp } from "./config.mjs";
import { inspectIssue, inspectOwnPr, readFeedback } from "./admission.mjs";
import { pendingControls } from "./commands.mjs";
const sameRun = (a, b) => a?.id === b?.id && a?.attempt === b?.attempt;

// Called in a read-only job after the controller claims the operation. Every
// authority input comes from API reads, not a workflow-dispatch input or PR file.
export async function workerAssignment({ api, store, repo, repositoryId, itemKey, operationId, run }) {
  const { state } = await store.load();
  const item = state.items[itemKey], op = state.operations[operationId];
  const factoryApp = structuredClone(state.factoryApp);
  if (state.repositoryId !== repositoryId || !item || item.activeOperation !== operationId || op?.item !== itemKey
    || op.phase !== "claimed" || !sameRun(op.owner, run)) throw new Error("The Actions run does not own this work item");
  const config = withFactoryApp(parseConfig((await api.fileAt(".github/factory.yml", op.configSha)).content), factoryApp?.login);
  const number = Number(itemKey.split(":")[1]);
  async function readFresh() {
    const [{ state: current }, latest, actionsRun] = await Promise.all([store.load(), loadConfig(api), api.run(run.id)]);
    const record = current.items[itemKey], active = current.operations[operationId];
    if (!record || record.activeOperation !== operationId || active?.phase !== "claimed" || !sameRun(active.owner, run)
      || String(actionsRun.id) !== run.id || actionsRun.run_attempt !== run.attempt || actionsRun.status !== "in_progress") return { valid: false };
    if (factoryApp && (current.factoryApp?.id !== factoryApp.id || current.factoryApp?.login !== factoryApp.login)) return { valid: false, reason: "The factory App identity changed" };
    latest.config = withFactoryApp(latest.config, current.factoryApp?.login);
    let authorization, issue;
    if (record.evidence.own) {
      authorization = await inspectOwnPr(api, number, { ...latest, repo }, { evidence: record.evidence });
      issue = authorization.pr;
    } else {
      const inspected = await inspectIssue(api, number, latest.config, { evidence: record.evidence });
      authorization = inspected;
      issue = inspected.issue;
    }
    let head;
    try { head = await api.branchSha(active.target.branch); }
    catch (error) { if (error.status === 404) head = null; else throw error; }
    const feedback = await readFeedback(api, { issue: record.evidence.own ? null : number, prs: record.prs.map((p) => p.number) }, latest.config);
    return { valid: authorization.valid, reason: authorization.reason, revision: authorization.revision,
      generation: record.generation, paused: record.paused || record.continuation?.phase === "requested" || pendingControls(record, feedback, active.inputs).length > 0, head,
      owner: { id: String(actionsRun.id), attempt: actionsRun.run_attempt }, issue, feedback, failures: active.failureContext ?? [] };
  }
  return { assignment: { operation: op, item, config }, readFresh };
}
