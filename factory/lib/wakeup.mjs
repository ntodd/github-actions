// PR review events may execute a PR's copy of the caller. This job has no App
// key or model secrets and can send only an untrusted discovery hint.
export async function wakeReview({ api, write, eventName, event }) {
  if (!["pull_request_review", "pull_request_review_comment"].includes(eventName)
    || !Number.isSafeInteger(event.pull_request?.number) || event.pull_request.number < 1) throw new Error("Not a PR review wake-up");
  const repository = await api.repository();
  if (typeof repository.default_branch !== "string" || !repository.default_branch) throw new Error("Repository default branch is unavailable");
  try {
    await write.dispatch("factory.yml", repository.default_branch, { kind: "reconcile", target: event.pull_request.number });
    return { status: "dispatched", target: event.pull_request.number };
  } catch (error) {
    // Fork restrictions are not a reason to pass privileged credentials into
    // this entry. The scheduled controller scans supported work independently.
    if ([403, 404].includes(error.status)) return { status: "backstop", reason: "Review wake-up is unavailable with this event token" };
    throw error;
  }
}
