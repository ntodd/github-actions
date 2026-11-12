/// One admitted issue, two required PRs, and at most three automatic attempts.
/// GitHub permission checks are assumptions; the controller protocol is modeled.
/// Every controller action is atomic except publishing, whose lock spans
/// authorization, request submission, and receipt persistence. The remote push
/// can finish after a crash releases the lock, including after stop is recorded.
module factory {
  pure val PRS = Set(1, 2)
  pure val RUNS = Set(1, 2)
  pure val BUDGET = 3

  type Publication = {
    op: int, generation: int, expectedGeneration: int, paused: bool, admitted: bool,
    head: int, expectedHead: int, base: int, expectedBase: int,
    defaultRef: int, expectedDefaultRef: int,
    owner: int, resultOwner: int
  }
  type Merge = {
    pr: int, head: int, base: int, approval: int, checkHead: int,
    checkBase: int, integratedBase: int
  }
  type State = {
    generation: int, paused: bool, admitted: bool, op: int, opGeneration: int,
    phase: str, target: int, owner: int, expectedHead: int,
    expectedBase: int, expectedDefaultRef: int, defaultRef: int, attempts: int,
    deliveries: Set[(int, int)], live: Set[(int, int)], running: Set[(int, int)],
    artifacts: Set[(int, int)], result: bool, resultOp: int, resultOwner: int, locked: bool,
    requested: bool, pending: bool, rejected: bool, requests: List[Publication],
    applied: Set[int], receipts: Set[int], recovered: Set[int],
    publications: List[Publication],
    heads: int -> int, integrated: int -> int,
    approvals: int -> int, checkHeads: int -> int, checkBases: int -> int,
    checks: Set[(int, int, int)], main: int, humanVersion: int,
    merged: Set[int], merges: List[Merge], complete: bool,
    duplicateSeen: bool, staleSeen: bool, stoppedSeen: bool,
    crashSeen: bool, expiredSeen: bool
  }
  var s: State

  action init = s' = {
    generation: 0, paused: false, admitted: true, op: 0, opGeneration: 0,
    phase: "idle", target: 1, owner: 0, expectedHead: 0,
    expectedBase: 0, expectedDefaultRef: 0, defaultRef: 0, attempts: 0,
    deliveries: Set(), live: Set(), running: Set(),
    artifacts: Set(), result: false, resultOp: 0, resultOwner: 0, locked: false,
    requested: false, pending: false, rejected: false, requests: List(),
    applied: Set(), receipts: Set(), recovered: Set(), publications: List(),
    heads: PRS.mapBy(_ => 0), integrated: PRS.mapBy(_ => 0),
    approvals: PRS.mapBy(_ => -1), checkHeads: PRS.mapBy(_ => -1),
    checkBases: PRS.mapBy(_ => -1), checks: Set(), main: 0, humanVersion: 1000,
    merged: Set(), merges: List(), complete: false,
    duplicateSeen: false, staleSeen: false, stoppedSeen: false,
    crashSeen: false, expiredSeen: false
  }

  val terminal = Set("idle", "done", "failed", "superseded").contains(s.phase)
  val currentResult = all {
    s.result, s.resultOp == s.op, s.resultOwner == s.owner, s.owner != 0,
    s.opGeneration == s.generation, not(s.paused), s.admitted,
    s.defaultRef == s.expectedDefaultRef,
    s.heads.get(s.target) == s.expectedHead,
    not(s.merged.contains(s.target))
  }

  action reserve(pr: int): bool = all {
    not(s.locked), not(s.paused), s.admitted, not(s.complete), terminal,
    (s.live.size() == 0), s.attempts < BUDGET, not(s.merged.contains(pr)),
    s' = { ...s, op: s.op + 1, opGeneration: s.generation,
      phase: "prepared", target: pr, owner: 0,
      expectedHead: s.heads.get(pr), expectedBase: s.main,
      expectedDefaultRef: s.defaultRef,
      attempts: s.attempts + 1, result: false, resultOp: 0, resultOwner: 0,
      requested: false, pending: false, rejected: false }
  }

  // Sending the same operation again models a lost dispatch response.
  // Old deliveries remain available, so they can arrive after a retry.
  action dispatch(runId: int): bool = all {
    s.phase == "prepared", not(s.locked),
    s' = { ...s, deliveries: s.deliveries.union(Set((s.op, runId))) }
  }

  action claim(op: int, runId: int): bool = all {
    not(s.locked), s.deliveries.contains((op, runId)),
    op == s.op, s.phase == "prepared", s.owner == 0,
    not(s.paused), s.admitted, s.opGeneration == s.generation, (s.live.size() == 0),
    s.defaultRef == s.expectedDefaultRef,
    s.heads.get(s.target) == s.expectedHead, not(s.merged.contains(s.target)),
    s' = { ...s, owner: runId, phase: "claimed", live: Set((op, runId)) }
  }

  // Abstracts an explicit work request after dispatch retries are exhausted.
  // Deliveries remain in flight, but the retired reservation cannot be claimed.
  action abandonPrepared = all {
    not(s.locked), s.phase == "prepared", s.owner == 0, s.live.size() == 0,
    s.opGeneration == s.generation, s.heads.get(s.target) == s.expectedHead,
    not(s.merged.contains(s.target)), s.main == s.expectedBase, s.defaultRef == s.expectedDefaultRef,
    s' = { ...s, phase: "superseded" }
  }

  action rejectDelivery(op: int, runId: int): bool = all {
    not(s.locked), s.deliveries.contains((op, runId)),
    op != s.op or s.owner != 0 or s.paused or s.opGeneration != s.generation or s.phase != "prepared",
    s' = { ...s, duplicateSeen: true }
  }

  action startWorker = all {
    s.phase == "claimed", s.live.contains((s.op, s.owner)),
    (s.running.size() == 0), not(s.paused), s.opGeneration == s.generation,
    s.defaultRef == s.expectedDefaultRef,
    s' = { ...s, running: s.live }
  }

  // Artifacts are external data. Workers never advance the durable phase.
  action uploadResult = all {
    s.phase == "claimed", s.running.size() > 0,
    s' = { ...s, artifacts: s.artifacts.union(Set((s.op, s.owner))) }
  }

  action finishWorker = all {
    s.phase == "claimed", s.running.size() > 0,
    s' = { ...s, live: Set(), running: Set(),
      artifacts: s.artifacts.union(Set((s.op, s.owner))) }
  }

  action collectResult(op: int, runId: int): bool = all {
    not(s.locked), s.phase == "claimed", s.live.size() == 0,
    s.artifacts.contains((op, runId)), op == s.op, runId == s.owner,
    s' = { ...s, result: true, resultOp: op, resultOwner: runId,
      phase: "result-ready" }
  }

  // Another workflow can upload a similarly named artifact. Provenance,
  // rather than its name or contents, must match the recorded owner.
  action foreignArtifact(runId: int): bool = all {
    s.phase == "claimed", runId != s.owner,
    s' = { ...s, artifacts: s.artifacts.union(Set((s.op, runId))) }
  }

  action crashWorker = all {
    s.phase == "claimed", not((s.live.size() == 0)),
    s' = { ...s, live: Set(), running: Set(), crashSeen: true }
  }

  // A timeout cannot be treated as confirmation that the worker terminated.
  action requestCancellation = all {
    not((s.live.size() == 0)),
    s' = s
  }

  action recoverDeadWorker = all {
    not(s.locked), s.phase == "claimed", (s.live.size() == 0), not(s.artifacts.contains((s.op, s.owner))),
    s' = { ...s, phase: "failed" }
  }

  action stop = all {
    not(s.locked), not(s.paused), not(s.complete),
    s' = { ...s, paused: true, generation: s.generation + 1, stoppedSeen: true }
  }

  action resume = all {
    not(s.locked), s.paused,
    s' = { ...s, paused: false }
  }

  // A definitive loss of admission fences old work. Restored API trust alone
  // cannot restore permission: readmission abstracts a fresh trusted source.
  action revokeAdmission = all {
    not(s.locked), s.admitted,
    s' = { ...s, admitted: false, generation: s.generation + 1 }
  }

  action readmit = all {
    not(s.locked), not(s.admitted), terminal, s.live.size() == 0,
    s' = { ...s, admitted: true }
  }

  action discardStale = all {
    not(s.locked), (s.live.size() == 0),
    Set("prepared", "result-ready").contains(s.phase),
    s.opGeneration != s.generation or s.heads.get(s.target) != s.expectedHead
      or s.main != s.expectedBase or s.defaultRef != s.expectedDefaultRef or s.merged.contains(s.target),
    s' = { ...s, phase: "superseded", staleSeen: true }
  }

  action expireResult = all {
    not(s.locked), s.phase == "result-ready", s.result,
    s' = { ...s, result: false, expiredSeen: true }
  }

  action recoverMissingResult = all {
    not(s.locked), s.phase == "result-ready", not(s.result),
    s' = { ...s, phase: "failed" }
  }

  action authorizePublish = all {
    not(s.locked), s.phase == "result-ready", currentResult,
    s.main == s.expectedBase,
    s' = { ...s, locked: true, phase: "publishing" }
  }

  // Submit under the controller lock, with authorization fixed at submission.
  // This models the recorded intent and an HTTP request whose outcome may
  // remain unknown after a crash. It is not yet a remote branch mutation.
  action push = all {
    s.locked, s.phase == "publishing", currentResult,
    not(s.requested), not(s.applied.contains(s.op)),
    s' = { ...s, requested: true, pending: true,
      requests: s.requests.append({ op: s.op,
        generation: s.generation, expectedGeneration: s.opGeneration,
        paused: s.paused, admitted: s.admitted, head: s.heads.get(s.target), expectedHead: s.expectedHead,
        base: s.main, expectedBase: s.expectedBase,
        defaultRef: s.defaultRef, expectedDefaultRef: s.expectedDefaultRef,
        owner: s.owner, resultOwner: s.resultOwner }) }
  }

  // GitHub applies an already-submitted request, possibly after crash/stop.
  // Only the branch's expected head is atomic with this external mutation.
  // There is no atomic transaction spanning main, the PR and the ledger.
  action applyPush = all {
    s.pending, s.heads.get(s.target) == s.expectedHead,
    not(s.applied.contains(s.op)),
    val newHead = 100 + s.op
    s' = { ...s, pending: false,
      heads: s.heads.set(s.target, newHead),
      integrated: s.integrated.set(s.target, s.expectedBase),
      applied: s.applied.union(Set(s.op)),
      checks: s.checks.union(Set((s.target, newHead, s.expectedBase))),
      publications: s.publications.append({ op: s.op,
        generation: s.generation, expectedGeneration: s.opGeneration,
        paused: s.paused, admitted: s.admitted, head: s.heads.get(s.target), expectedHead: s.expectedHead,
        base: s.main, expectedBase: s.expectedBase,
        defaultRef: s.defaultRef, expectedDefaultRef: s.expectedDefaultRef,
        owner: s.owner, resultOwner: s.resultOwner }) }
  }

  // A definitive failed response establishes that this request has no effect.
  // Merely reading the old branch head is not such evidence: it may be pending.
  action rejectPush = all {
    s.pending,
    s' = { ...s, pending: false, rejected: true }
  }

  action persistReceipt = all {
    s.locked, s.phase == "publishing", s.applied.contains(s.op),
    s' = { ...s, receipts: s.receipts.union(Set(s.op)), phase: "done", locked: false }
  }

  action crashPublisher = all {
    s.locked, s.phase == "publishing",
    s' = { ...s, locked: false, crashSeen: true }
  }

  // Discover the exact published commit in remote history, even if a human
  // has since added another commit. Do not repeat the push.
  action recoverPublished = all {
    not(s.locked), s.phase == "publishing", s.applied.contains(s.op),
    s' = { ...s, receipts: s.receipts.union(Set(s.op)),
      recovered: s.recovered.union(Set(s.op)), phase: "done" }
  }

  action recoverUnpublished = all {
    not(s.locked), s.phase == "publishing", not(s.applied.contains(s.op)),
    not(s.requested) or s.rejected,
    s' = { ...s, phase: "result-ready", requested: false, rejected: false }
  }

  action finishRejectedPublish = all {
    s.locked, s.phase == "publishing", s.rejected,
    s' = { ...s, locked: false, phase: "result-ready",
      requested: false, rejected: false }
  }

  action rejectRacedPublish = all {
    s.locked, s.phase == "publishing", not(s.requested),
    not(currentResult),
    s' = { ...s, locked: false, phase: "superseded", staleSeen: true }
  }

  action humanPush(pr: int): bool = all {
    not(s.merged.contains(pr)),
    s' = { ...s, heads: s.heads.set(pr, s.humanVersion),
      humanVersion: s.humanVersion + 1,
      checks: s.checks.union(Set((pr, s.humanVersion, s.integrated.get(pr)))) }
  }

  action mainMoves = s' = { ...s, main: s.main + 1 }

  // Repository policy can change while a publisher holds its own lock. The
  // branch name may change independently of the base commit's identity.
  action defaultBranchChanges = s' = { ...s, defaultRef: s.defaultRef + 1 }

  action approve(pr: int): bool = all {
    not(s.merged.contains(pr)),
    s' = { ...s, approvals: s.approvals.set(pr, s.heads.get(pr)) }
  }

  action observeCI(pr: int, commit: int, base: int): bool = all {
    s.checks.contains((pr, commit, base)),
    if (s.heads.get(pr) == commit and s.main == base) {
      s' = { ...s, checkHeads: s.checkHeads.set(pr, commit),
        checkBases: s.checkBases.set(pr, base) }
    } else {
      s' = { ...s, staleSeen: true }
    }
  }

  // GitHub, not the controller, enforces these merge preconditions. This
  // model assumes they hold and checks that lifecycle completion uses them.
  action merge(pr: int): bool = all {
    not(s.merged.contains(pr)),
    s.approvals.get(pr) == s.heads.get(pr),
    s.checkHeads.get(pr) == s.heads.get(pr),
    s.checkBases.get(pr) == s.main, s.integrated.get(pr) == s.main,
    s' = { ...s, merged: s.merged.union(Set(pr)), main: s.main + 1,
      merges: s.merges.append({ pr: pr, head: s.heads.get(pr), base: s.main,
        approval: s.approvals.get(pr), checkHead: s.checkHeads.get(pr),
        checkBase: s.checkBases.get(pr), integratedBase: s.integrated.get(pr) }) }
  }

  action closeOut = all {
    not(s.locked), s.admitted, s.merged == PRS,
    s' = { ...s, complete: true }
  }

  // Delay, lost wake-ups and API read failures leave lifecycle state intact.
  // Read backoff/attention metadata is outside this ownership projection.
  // Fair delivery is a separate liveness assumption.
  action idle = s' = s

  action step = any {
    nondet pr = PRS.oneOf()
    reserve(pr),
    nondet runId = RUNS.oneOf()
    dispatch(runId),
    nondet packet = s.deliveries.oneOf()
    any { claim(packet._1, packet._2), rejectDelivery(packet._1, packet._2) },
    startWorker, uploadResult, finishWorker, crashWorker, requestCancellation,
    nondet artifact = s.artifacts.oneOf()
    collectResult(artifact._1, artifact._2),
    nondet runId = RUNS.oneOf()
    foreignArtifact(runId),
    recoverDeadWorker, stop, resume, revokeAdmission, readmit, discardStale, abandonPrepared, expireResult,
    recoverMissingResult, authorizePublish, push, applyPush, rejectPush, persistReceipt,
    crashPublisher, recoverPublished, recoverUnpublished, finishRejectedPublish,
    rejectRacedPublish,
    nondet pr = PRS.oneOf()
    humanPush(pr),
    mainMoves, defaultBranchChanges,
    nondet pr = PRS.oneOf()
    approve(pr),
    nondet check = s.checks.oneOf()
    observeCI(check._1, check._2, check._3),
    nondet pr = PRS.oneOf()
    merge(pr),
    closeOut, idle
  }

  // A second exploration profile keeps inputs stable while retaining lost
  // dispatch responses and publisher crashes. It exercises recovery and
  // completion far more often than the deliberately hostile main profile.
  action recoveryStep = any {
    nondet pr = PRS.oneOf()
    all { s.heads.get(pr) == 0 or s.integrated.get(pr) != s.main, reserve(pr) },
    nondet runId = RUNS.oneOf()
    dispatch(runId),
    nondet packet = s.deliveries.oneOf()
    any { claim(packet._1, packet._2), rejectDelivery(packet._1, packet._2) },
    startWorker, finishWorker,
    collectResult(s.op, s.owner),
    authorizePublish, push, applyPush, rejectPush, persistReceipt,
    crashPublisher, recoverPublished, recoverUnpublished, finishRejectedPublish,
    discardStale, rejectRacedPublish,
    nondet pr = PRS.oneOf()
    approve(pr),
    nondet check = s.checks.oneOf()
    observeCI(check._1, check._2, check._3),
    nondet pr = PRS.oneOf()
    merge(pr),
    closeOut, idle
  }

  val oneOwner = all {
    s.live.size() <= 1, s.running.subseteq(s.live),
    s.live.forall(identity => identity == (s.op, s.owner))
  }
  val boundedAttempts = s.attempts <= BUDGET and s.op == s.attempts
  val authorizedPublishRequests = s.requests.indices().map(i => s.requests.nth(i)).forall(p => all {
    p.generation == p.expectedGeneration, not(p.paused), p.admitted,
    p.defaultRef == p.expectedDefaultRef,
    p.head == p.expectedHead,
    p.owner == p.resultOwner, p.owner != 0
  })
  val noHeadOverwrite = s.publications.indices().map(i => s.publications.nth(i))
    .forall(p => p.head == p.expectedHead)
  val acceptedResultHasOwner = not(s.result) or
    (s.resultOp == s.op and s.resultOwner == s.owner and s.owner != 0)
  val unresolvedPublishKeepsOperation = not(s.pending) or
    (s.phase == "publishing" and s.requested and not(s.receipts.contains(s.op)))
  val noDuplicatePush = s.publications.length() == s.applied.size()
  val receiptsHaveEffects = s.receipts.subseteq(s.applied)
  val reviewedIntegration = s.merges.indices().map(i => s.merges.nth(i)).forall(m => all {
    m.approval == m.head, m.checkHead == m.head,
    m.checkBase == m.base, m.integratedBase == m.base
  })
  val completeMeansAllMerged = not(s.complete) or s.merged == PRS
  val waitsReleaseCrew = Set("result-ready", "publishing", "done", "failed", "superseded").contains(s.phase)
    implies (s.running.size() == 0)
  val safety = all { oneOwner, boundedAttempts, authorizedPublishRequests,
    noHeadOverwrite, acceptedResultHasOwner, unresolvedPublishKeepsOperation,
    noDuplicatePush, receiptsHaveEffects, reviewedIntegration,
    completeMeansAllMerged, waitsReleaseCrew }

  val duplicateDelivery = s.duplicateSeen
  val recoveredPush = not((s.recovered.size() == 0))
  val staleRejected = s.staleSeen
  val stoppedWithLiveWorker = s.paused and not((s.live.size() == 0))
  val budgetExhausted = s.attempts == BUDGET
  val partialCompletion = s.merged.size() == 1 and not(s.complete)
  val fullCompletion = s.complete
  val artifactExpired = s.expiredSeen
  val latePushAfterStop = s.publications.indices().map(i => s.publications.nth(i))
    .exists(p => p.generation != p.expectedGeneration)
  val baseMovedBeforePush = s.publications.indices().map(i => s.publications.nth(i))
    .exists(p => p.base != p.expectedBase)

  run resultFor(pr) = reserve(pr).then(dispatch(1)).then(claim(s.op, 1))
    .then(startWorker).then(finishWorker).then(collectResult(s.op, s.owner))
  run publish = authorizePublish.then(push).then(applyPush).then(persistReceipt)
  run accept(pr) = approve(pr)
    .then(observeCI(pr, s.heads.get(pr), s.main)).then(merge(pr))

  run duplicateDispatchTest = init.then(reserve(1))
    .then(dispatch(1)).then(dispatch(2)).then(claim(1, 1))
    .then(rejectDelivery(1, 2))
    .expect(s.owner == 1 and s.attempts == 1 and oneOwner)

  run changedHeadCannotClaimTest = init.then(reserve(1)).then(dispatch(1))
    .then(humanPush(1)).then(claim(1, 1)).fail()

  run stopFencesResultTest = init.then(resultFor(1)).then(stop)
    .then(resume).then(discardStale)
    .expect((s.applied.size() == 0) and s.phase == "superseded" and safety)

  run queuedOwnerCannotBeReplacedTest = init.then(reserve(1))
    .then(dispatch(1)).then(claim(1, 1)).then(requestCancellation)
    .then(reserve(2)).fail()

  run deadWorkerRetryTest = init.then(reserve(1)).then(dispatch(1))
    .then(claim(1, 1)).then(crashWorker).then(recoverDeadWorker)
    .then(reserve(1)).then(dispatch(2)).then(claim(2, 2))
    .then(rejectDelivery(1, 1)).expect(s.owner == 2 and s.attempts == 2 and safety)

  run pushBeforeReceiptCrashTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(applyPush).then(crashPublisher)
    .then(humanPush(1)).then(recoverPublished)
    .expect(s.publications.length() == 1 and s.receipts == Set(1) and safety)

  run humanPushDuringPublishTest = init.then(resultFor(1))
    .then(authorizePublish).then(humanPush(1)).then(rejectRacedPublish)
    .expect((s.applied.size() == 0) and s.heads.get(1) == 1000 and safety)

  run mainMovesDuringPublishTest = init.then(resultFor(1))
    .then(authorizePublish).then(mainMoves).then(push).then(applyPush)
    .then(persistReceipt).then(approve(1)).then(observeCI(1, 101, 0))
    .expect(baseMovedBeforePush and s.integrated.get(1) != s.main and safety)

  run outdatedIntegrationCannotMergeTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(mainMoves).then(applyPush)
    .then(persistReceipt).then(approve(1)).then(observeCI(1, 101, 0))
    .then(merge(1)).fail()

  run stopAfterUnrecordedPushTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(applyPush).then(crashPublisher).then(stop)
    .then(recoverPublished)
    .expect(s.paused and s.receipts == Set(1) and safety)

  run stopWaitsForPublisherTest = init.then(resultFor(1))
    .then(authorizePublish).then(stop).fail()

  run oldApprovalCannotMergeTest = init.then(approve(1))
    .then(resultFor(1)).then(publish).then(observeCI(1, 101, 0))
    .then(merge(1)).fail()

  run oldCICannotMakeNewHeadReadyTest = init.then(resultFor(1)).then(publish)
    .then(humanPush(1)).then(observeCI(1, 101, 0))
    .expect(s.checkHeads.get(1) != s.heads.get(1) and safety)

  run partialCompletionTest = init.then(resultFor(1)).then(publish)
    .then(accept(1)).expect(partialCompletion and safety)

  run fullCompletionTest = init.then(resultFor(1)).then(publish).then(accept(1))
    .then(resultFor(2)).then(publish).then(accept(2)).then(closeOut)
    .expect(fullCompletion and safety)

  run missingArtifactTest = init.then(resultFor(1)).then(expireResult)
    .then(recoverMissingResult).then(resultFor(1)).then(publish)
    .expect(s.attempts == 2 and s.publications.length() == 1 and safety)

  run workerCannotAdvanceLedgerTest = init.then(reserve(1)).then(dispatch(1))
    .then(claim(1, 1)).then(startWorker).then(finishWorker)
    .expect(s.phase == "claimed" and not(s.result) and s.artifacts.contains((1, 1)))

  run crashAfterArtifactUploadTest = init.then(reserve(1)).then(dispatch(1))
    .then(claim(1, 1)).then(startWorker).then(uploadResult).then(crashWorker)
    .then(collectResult(1, 1)).then(publish)
    .expect(s.attempts == 1 and s.receipts == Set(1) and safety)

  run foreignResultCannotBeCollectedTest = init.then(reserve(1)).then(dispatch(1))
    .then(claim(1, 1)).then(foreignArtifact(2)).then(crashWorker)
    .then(collectResult(1, 2)).fail()

  run oldResultCannotBeCollectedTest = init.then(resultFor(1)).then(stop)
    .then(resume).then(discardStale).then(reserve(1)).then(dispatch(2))
    .then(claim(2, 2)).then(crashWorker).then(collectResult(1, 1)).fail()

  run delayedPushAfterStopTest = init.then(resultFor(1)).then(authorizePublish)
    .then(push).then(crashPublisher).then(stop).then(applyPush)
    .then(recoverPublished)
    .expect(latePushAfterStop and s.paused and s.receipts == Set(1) and safety)

  run delayedPushCannotOverwriteHumanTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher).then(humanPush(1))
    .then(applyPush).fail()

  run unresolvedRequestCannotRetryTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher)
    .then(recoverUnpublished).fail()

  run unresolvedRequestCannotReplaceOwnerTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher).then(stop).then(resume)
    .then(reserve(2)).fail()

  run rejectedRequestCanRecoverTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher).then(rejectPush)
    .then(recoverUnpublished).then(publish)
    .expect(s.requests.length() == 2 and s.publications.length() == 1 and safety)

  run noNewRequestAfterStopTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher).then(stop)
    .then(rejectPush).then(recoverUnpublished).then(authorizePublish).fail()

  run rejectedRequestWithoutCrashTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(rejectPush).then(finishRejectedPublish)
    .then(publish).expect(s.receipts == Set(1) and s.attempts == 1 and safety)

  run mergeWhilePushInFlightTest = init.then(resultFor(1)).then(publish)
    .then(approve(1)).then(observeCI(1, 101, 0)).then(resultFor(1))
    .then(authorizePublish).then(push).then(merge(1)).then(applyPush)
    .then(persistReceipt)
    .expect(s.merged.contains(1) and s.heads.get(1) == 102
      and s.merges.nth(0).head == 101 and safety)

  run automaticBudgetTest = init.then(resultFor(1)).then(expireResult)
    .then(recoverMissingResult).then(resultFor(1)).then(expireResult)
    .then(recoverMissingResult).then(resultFor(1)).then(expireResult)
    .then(recoverMissingResult).then(reserve(1)).fail()

  run abandonedDeliveryTest = init.then(reserve(1)).then(dispatch(1))
    .then(abandonPrepared).then(claim(1, 1)).fail()

  run replacedDeliveryTest = init.then(reserve(1)).then(dispatch(1))
    .then(abandonPrepared).then(reserve(1)).then(claim(1, 1)).fail()

  run revokedAdmissionCannotClaimTest = init.then(reserve(1)).then(dispatch(1))
    .then(revokeAdmission).then(claim(1, 1)).fail()

  run readmissionRetiresOldResultTest = init.then(resultFor(1)).then(revokeAdmission)
    .then(discardStale).then(readmit).then(reserve(1)).then(dispatch(2)).then(claim(1, 1)).fail()

  run revokedAdmissionCannotReserveTest = init.then(reserve(1)).then(revokeAdmission)
    .then(discardStale).then(reserve(1)).fail()

  run revokedAdmissionRecoversSentPushTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher).then(revokeAdmission)
    .then(applyPush).then(recoverPublished)
    .expect(not(s.admitted) and s.receipts == Set(1) and s.attempts == 1 and safety)

  run defaultBranchChangeFencesClaimTest = init.then(reserve(1)).then(dispatch(1))
    .then(defaultBranchChanges).then(claim(1, 1)).fail()

  run defaultBranchChangeFencesStartTest = init.then(reserve(1)).then(dispatch(1)).then(claim(1, 1))
    .then(defaultBranchChanges).then(startWorker).fail()

  run defaultBranchChangeFencesPublishTest = init.then(resultFor(1))
    .then(authorizePublish).then(defaultBranchChanges).then(push).fail()

  run defaultBranchChangeReplansTest = init.then(reserve(1)).then(dispatch(1)).then(defaultBranchChanges)
    .then(discardStale).then(reserve(1)).then(dispatch(2)).then(claim(2, 2))
    .expect(s.owner == 2 and s.expectedDefaultRef == s.defaultRef and s.main == 0 and safety)

  run defaultBranchChangeRecoversSentPushTest = init.then(resultFor(1))
    .then(authorizePublish).then(push).then(crashPublisher).then(defaultBranchChanges)
    .then(applyPush).then(recoverPublished)
    .expect(s.receipts == Set(1) and s.requests.length() == 1 and s.main == 0 and safety)

  run publishObservationOutageTest = init.then(resultFor(1)).then(idle).then(idle).then(idle)
    .expect(s.phase == "result-ready" and s.attempts == 1 and s.requests.length() == 0 and safety)

  run publishGuardOutageRecoveryTest = init.then(resultFor(1)).then(authorizePublish)
    .then(idle).then(idle).then(idle).then(push).then(applyPush).then(persistReceipt)
    .expect(s.receipts == Set(1) and s.requests.length() == 1 and s.attempts == 1 and safety)
}
