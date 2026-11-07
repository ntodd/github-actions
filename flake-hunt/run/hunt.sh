#!/usr/bin/env bash
# Runs the Mix project's suite FLAKE_HUNT_RUNS times, each with ExUnit's
# random seed, and appends what happened to FLAKE_HUNT_OUT as JSON lines:
# one per test per run (flake_formatter.exs) and one per run (this script).
# Failing tests don't fail the script. It exits 1 only when no run reported
# any tests, which means the suite never really ran.
#
#   FLAKE_HUNT_RUNS       how many runs
#   FLAKE_HUNT_OUT        the JSONL file to append to
#   FLAKE_HUNT_SHARD      this shard's number (default 1)
#   FLAKE_HUNT_TEST_ARGS  extra mix test arguments, split on whitespace
#
# Run it from the Mix project's directory, with MIX_ENV=test.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
: "${FLAKE_HUNT_RUNS:?}" "${FLAKE_HUNT_OUT:?}"
export FLAKE_HUNT_SHARD=${FLAKE_HUNT_SHARD:-1}
# The physical path: ExUnit reports test files by their real path.
FLAKE_HUNT_ROOT=$(pwd -P)
export FLAKE_HUNT_ROOT
read -r -a extra <<< "${FLAKE_HUNT_TEST_ARGS:-}"

mkdir -p "$(dirname "$FLAKE_HUNT_OUT")"
touch "$FLAKE_HUNT_OUT"

count_tests() { grep -c '"type":"test"' "$FLAKE_HUNT_OUT" || true; }

reported=0
nonzero=0
for run in $(seq 1 "$FLAKE_HUNT_RUNS"); do
  before=$(count_tests)
  echo "::group::Run $run of $FLAKE_HUNT_RUNS"
  FLAKE_HUNT_RUN=$run elixir -r "$here/flake_formatter.exs" -S mix test \
    --formatter ExUnit.CLIFormatter --formatter FlakeHunt.Formatter ${extra[@]+"${extra[@]}"}
  status=$?
  echo "::endgroup::"
  tests=$(($(count_tests) - before))
  printf '{"type":"run","shard":%d,"run":%d,"exit":%d,"tests":%d}\n' \
    "$FLAKE_HUNT_SHARD" "$run" "$status" "$tests" >> "$FLAKE_HUNT_OUT"
  if [ "$tests" -gt 0 ]; then reported=$((reported + 1)); fi
  if [ "$status" -ne 0 ]; then nonzero=$((nonzero + 1)); fi
  echo "Run $run: exit $status, $tests tests"
done

echo "Shard $FLAKE_HUNT_SHARD: $reported of $FLAKE_HUNT_RUNS runs reported tests, $nonzero exited non-zero."
if [ "$reported" -eq 0 ]; then
  echo "::error::No run reported any tests. The suite may not compile, or setup failed: see the runs above."
  exit 1
fi
