# Importing legacy work

Run administrator setup first to initialize protected `factory-state` with
the verified App identity. Install a reviewed caller pinned to a shared
runtime that supports migration. The caller can remain read-only throughout
cutover.

Manually dispatch `factory.yml` on the default branch from a configured
trusted human account. Start with this `request`:

```json
{"kind":"migrate"}
```

This inventories open issues and PRs without minting an installation token
or changing records. Planning remains available while the legacy runtime
is active. The inventory is data; PR prose does not establish membership.

Select existing work explicitly, then request a plan:

```json
{"kind":"migrate","items":[{"issue":7,"prs":[9],"disposition":"question"}]}
```

Each selected issue must still pass admission using its original trusted
label or build/restart command. `source` can select a specific source such
as `label:123`. The importer verifies App authorship and repository/head
identity for each mapped PR. Closing references to another issue must be
corrected before import. Existing App PRs targeting another branch are
recorded with their actual head and base snapshots. Multiple open PRs or
off-default bases turn `continue` into a question; import never retargets
them or starts stack maintenance. A reviewed `stop` remains a pause. Merged
PRs retain their actual merge SHA and base; completion still needs verified
default-branch coverage or an explicit accepted alternative.

Choose a disposition for each item:

- `question` (the default) holds work for clarification. An optional `reason`
  supplies the question. A legacy blocked label alone cannot identify a
  failed run or establish its result.
- `stop` records a pause.
- `continue` accepts the existing PR membership for reconciliation after
  activation. An issue without PRs needs a question or stop, so import cannot
  silently admit a replacement build.

To record a person's PR, use `{"pr":12,"disposition":"continue"}`. Its
original trusted update/resolve command is revalidated. Legacy maintenance
is retained as history; a fresh `/agent update` or `/agent resolve`
is required for another operation.

Review the plan's tooling and configuration commits, original admission, PR snapshots,
legacy command list and effective dispositions. Disable every legacy entry
and confirm its runs are terminal. Dispatch the exact `applyRequest` printed
by the plan. Its digest binds the observed repository, ledger, membership,
prose and conversation; changed facts require another plan.

Application runs under `factory-control` and requests a repository-scoped
token with `contents: write`. It writes only the ledger and emits no worker
outputs. Original admission and import provenance remain recorded. Observed
legacy commands are retained as history and marked accordingly in worker
context. Legacy model cost and Crew minutes remain explicitly unmeasured.

An existing factory item is preserved rather than replaced. Unfinished
operations and uncertain effects must settle first. A repeated applied
request reports `already-imported`, including after a lost state response.
The report lists unmapped App PRs. Activation also checks open legacy-labeled
issues, including ones whose old PR has already closed, so their membership
or uncertainty must be recorded before cutover. Migration does not establish live permission,
approval or Crew isolation behavior; the sandbox acceptance gates still apply.
