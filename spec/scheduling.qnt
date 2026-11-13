/// One durable prepared operation and the Actions control concurrency group.
/// With queue: max GitHub permits one running and 100 pending jobs. An overflow
/// cancels the new job. Cancellation is not a durable operation transition.
module scheduling {
  type Job = { kind: str, id: int }
  type State = {
    phase: str, requests: int, owner: int, claimants: Set[int],
    active: Job, pending: List[Job], deliveries: Set[int], due: bool, asked: bool,
    workerDone: bool, displaced: bool, lost: bool, noiseDisplaced: bool,
    lastAction: str, event: str, runId: int, accepted: bool
  }
  pure val NONE = { kind: "none", id: 0 }
  pure val CAPACITY = 100
  pure val NOISE = Set("app-comment", "app-label", "app-review",
    "controller-completion", "collector-completion", "inspect-completion")
  pure val WAKEUPS = Set("human", "ci", "backstop", "review-hint", "app-pr-opened", "worker-completion")
  pure def accepts(kind: str): bool = WAKEUPS.contains(kind)
  var s: State

  action init = s' = {
    phase: "prepared", requests: 0, owner: 0, claimants: Set(),
    active: NONE, pending: [], deliveries: Set(), due: true, asked: false,
    workerDone: false, displaced: false, lost: false, noiseDisplaced: false,
    lastAction: "init", event: "", runId: 0, accepted: false
  }

  pure def enqueue(state: State, job: Job): State = {
    ...state,
    active: if (state.active == NONE) job else state.active,
    pending: if (state.active != NONE and state.pending.length() < CAPACITY) state.pending.append(job) else state.pending,
    displaced: state.displaced or (state.active != NONE and state.pending.length() == CAPACITY and job.kind == "worker")
  }

  // A job-level filter runs before admission to control concurrency. A return
  // inside Node is too late: it would already have consumed a pending slot.
  action arrive(kind: str): bool = all {
    WAKEUPS.union(NOISE).contains(kind),
    kind != "worker-completion" or s.workerDone,
    val admitted = accepts(kind)
    val queued = if (admitted) enqueue(s, { kind: kind, id: 0 }) else s
    s' = { ...queued, lastAction: "arrive", event: kind, runId: 0, accepted: admitted,
      noiseDisplaced: s.noiseDisplaced or (NOISE.contains(kind) and admitted) }
  }

  // The request is recorded before the API call. A lost response or a canceled
  // delivery spends a dispatch request, but never another coding reservation.
  action dispatch = all {
    s.active != NONE, s.active.kind != "worker", s.phase == "prepared",
    not(s.asked), s.due, s.requests < 3,
    s' = { ...s, requests: s.requests + 1, due: false,
      deliveries: s.deliveries.union(Set(s.requests + 1)), lastAction: "dispatch" }
  }

  action deliver(id: int): bool = all {
    s.deliveries.contains(id),
    val queued = enqueue(s, { kind: "worker", id: id })
    s' = { ...queued, deliveries: s.deliveries.exclude(Set(id)), lastAction: "deliver", runId: id }
  }

  action loseDelivery(id: int): bool = all {
    s.deliveries.contains(id),
    s' = { ...s, deliveries: s.deliveries.exclude(Set(id)), lost: true, lastAction: "lose-delivery", runId: id }
  }

  action cancelPending = all {
    s.pending.length() > 0, s.pending.head().kind == "worker",
    s' = { ...s, pending: s.pending.tail(), lost: true, lastAction: "cancel-pending" }
  }

  // Finishing or crashing releases only the control job. Claimed workers keep
  // their durable owner after control releases the mutex and Crew starts them.
  action finishControl = all {
    s.active != NONE,
    s' = { ...s, active: if (s.pending.length() > 0) s.pending.head() else NONE,
      pending: if (s.pending.length() > 0) s.pending.tail() else [], lastAction: "finish-control" }
  }

  action crashControl = all {
    s.active != NONE,
    s' = { ...s, active: if (s.pending.length() > 0) s.pending.head() else NONE,
      pending: if (s.pending.length() > 0) s.pending.tail() else [], lost: true, lastAction: "crash-control" }
  }

  action backoffElapsed = all {
    not(s.due),
    s' = { ...s, due: true, lastAction: "backoff-elapsed" }
  }

  action claim = all {
    s.active.kind == "worker", s.phase == "prepared", s.owner == 0, not(s.asked),
    s' = { ...s, phase: "claimed", owner: s.active.id,
      claimants: s.claimants.union(Set(s.active.id)), lastAction: "claim" }
  }

  action finishWorker = all {
    s.phase == "claimed", not(s.workerDone),
    not(s.active.kind == "worker" and s.active.id == s.owner),
    s' = { ...s, workerDone: true, lastAction: "finish-worker" }
  }

  action collect = all {
    s.active != NONE, s.active.kind != "worker", s.phase == "claimed", s.workerDone,
    s' = { ...s, phase: "result-ready", lastAction: "collect" }
  }

  action ask = all {
    s.active != NONE, s.active.kind != "worker", s.phase == "prepared", s.requests == 3, not(s.asked),
    s' = { ...s, asked: true, lastAction: "ask" }
  }

  val oneOwner = s.claimants.size() <= 1 and
    (if (s.owner == 0) s.claimants == Set() else s.claimants == Set(s.owner))
  val boundedDispatch = s.requests >= 0 and s.requests <= 3
  val durableOwnership = (s.phase == "prepared") == (s.owner == 0)
  val questionFencesClaim = not(s.asked) or (s.phase == "prepared" and s.owner == 0 and s.requests == 3)
  val filteredBeforeQueue = not(s.noiseDisplaced) and
    (s.lastAction != "arrive" or not(NOISE.contains(s.event)) or not(s.accepted))
  val queueShape = s.pending.length() <= CAPACITY and (s.active != NONE or s.pending.length() == 0)
  val safety = oneOwner and boundedDispatch and durableOwnership and questionFencesClaim and filteredBeforeQueue and queueShape

  val ignoredWakeup = s.lastAction == "arrive" and not(s.accepted)
  val displacedWorker = s.displaced
  val lostRequest = s.lost
  val recoveredDispatch = s.owner > 1
  val exhaustedDispatch = s.asked
  val collectedResult = s.phase == "result-ready"

  action idle = s' = { ...s, lastAction: "idle" }
  action step = any {
    nondet kind = WAKEUPS.union(NOISE).oneOf()
    arrive(kind),
    dispatch,
    nondet delivery = Set(1, 2, 3).oneOf()
    deliver(delivery),
    nondet lost = Set(1, 2, 3).oneOf()
    loseDelivery(lost),
    cancelPending, finishControl, crashControl, backoffElapsed, claim, finishWorker, collect, ask, idle
  }

  run queuedWorker = arrive("backstop").then(dispatch).then(deliver(1))
  run claimedWorker = queuedWorker.then(finishControl).then(claim).then(finishControl)
  run lostRequestRound = arrive("backstop").then(dispatch).then(loseDelivery(s.requests)).then(finishControl).then(backoffElapsed)

  run selfSurfacesPreserveWorkerTest = init.then(queuedWorker)
    .then(arrive("app-comment")).then(arrive("app-label")).then(arrive("app-review"))
    .expect(s.pending == [{ kind: "worker", id: 1 }] and safety)

  run nonWorkerCompletionsPreserveWorkerTest = init.then(queuedWorker)
    .then(arrive("controller-completion")).then(arrive("collector-completion")).then(arrive("inspect-completion"))
    .expect(s.pending == [{ kind: "worker", id: 1 }] and safety)

  run humanAndCiPreserveWorkerTest = init.then(queuedWorker).then(arrive("human")).then(arrive("ci"))
    .then(finishControl).then(claim)
    .expect(not(s.displaced) and s.requests == 1 and s.owner == 1 and s.pending.length() == 2 and safety)

  // These are opaque deliveries for four independent operations. Their queue
  // retention is modeled here; the durable lifecycle projection remains one operation.
  action batchWorkers = s' = { ...List(1, 2, 3, 4).foldl(s, (state, id) => enqueue(state, { kind: "worker", id: id })),
    lastAction: "batch-workers" }
  run fourWorkersRetainedTest = init.then(arrive("backstop")).then(batchWorkers)
    .expect(s.pending.foldl(List(), (ids, job) => ids.append(job.id)) == List(1, 2, 3, 4) and safety)
    .then(finishControl).expect(s.active.id == 1)
    .then(finishControl).expect(s.active.id == 2)
    .then(finishControl).expect(s.active.id == 3)
    .then(finishControl).expect(s.active.id == 4 and s.pending.length() == 0 and safety)

  action fillQueue = s' = { ...1.to(CAPACITY).fold(s, (state, _) => enqueue(state, { kind: "human", id: 0 })),
    lastAction: "fill-queue" }
  run overflowKeepsExistingJobsTest = init.then(arrive("backstop")).then(fillQueue)
    .then(dispatch).then(deliver(1))
    .expect(s.displaced and s.pending.length() == CAPACITY and s.pending.foldl(true, (ok, job) => ok and job.kind == "human") and safety)

  run lostDispatchBackstopTest = init.then(lostRequestRound).then(arrive("backstop"))
    .then(dispatch).then(deliver(2)).then(finishControl).then(claim)
    .expect(s.requests == 2 and s.owner == 2 and safety)

  run crashBeforeClaimBackstopTest = init.then(queuedWorker).then(finishControl).then(crashControl)
    .then(backoffElapsed).then(arrive("backstop")).then(dispatch).then(deliver(2)).then(finishControl).then(claim)
    .expect(s.lost and s.requests == 2 and s.owner == 2 and safety)

  run cancelBeforeClaimBackstopTest = init.then(queuedWorker).then(cancelPending).then(finishControl)
    .then(backoffElapsed).then(arrive("backstop")).then(dispatch).then(deliver(2)).then(finishControl).then(claim)
    .expect(s.lost and s.requests == 2 and s.owner == 2 and safety)

  run exhaustedDispatchesAskTest = init.then(lostRequestRound).then(lostRequestRound).then(lostRequestRound)
    .then(arrive("backstop")).then(ask).expect(exhaustedDispatch and safety)

  run noFourthDispatchTest = init.then(lostRequestRound).then(lostRequestRound).then(lostRequestRound)
    .then(arrive("backstop")).then(dispatch).fail()

  run noImmediateRedispatchTest = init.then(arrive("backstop")).then(dispatch).then(dispatch).fail()

  run lateWorkerCannotBypassQuestionTest = init.then(lostRequestRound).then(lostRequestRound)
    .then(arrive("backstop")).then(dispatch).then(ask).then(deliver(3)).then(finishControl).then(claim).fail()

  run duplicateDeliveryCannotClaimTest = init.then(arrive("backstop")).then(dispatch)
    .then(backoffElapsed).then(dispatch).then(deliver(1)).then(finishControl).then(claim)
    .then(deliver(2)).then(finishControl).then(claim).fail()

  run workerCompletionCollectsTest = init.then(claimedWorker).then(finishWorker)
    .then(arrive("worker-completion")).then(collect).expect(collectedResult and safety)

  run lostCompletionBackstopCollectsTest = init.then(claimedWorker).then(finishWorker)
    .then(arrive("backstop")).then(collect).expect(collectedResult and safety)
}
