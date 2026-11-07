#!/usr/bin/env bash
# Runs Claude Code once per prompt, from the Mix project's directory, and
# writes each final answer to <out dir>/<id>.md. A failed or empty answer
# leaves no file, and that issue goes out without a diagnosis. Claude may
# edit files to test an idea, so the checkout is reset after each prompt.
#
#   diagnose.sh <prompts dir> <out dir>
#
#   CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY   the credentials
#   FLAKE_HUNT_MODEL       optional --model
#   FLAKE_HUNT_MAX_TURNS   default 60
#   FLAKE_HUNT_TIMEOUT     per prompt, default 20m
set -uo pipefail

prompts=${1:?prompts dir}
out=${2:?out dir}
mkdir -p "$out"

# An unset secret arrives as an empty variable. Don't hand Claude an empty key.
for var in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
  if [ -z "${!var:-}" ]; then unset "$var"; fi
done

args=(-p --dangerously-skip-permissions --max-turns "${FLAKE_HUNT_MAX_TURNS:-60}")
if [ -n "${FLAKE_HUNT_MODEL:-}" ]; then args+=(--model "$FLAKE_HUNT_MODEL"); fi

repo=$(git rev-parse --show-toplevel)

for prompt in "$prompts"/*.md; do
  [ -e "$prompt" ] || continue
  id=$(basename "$prompt" .md)
  answer="$out/$id.md.partial"

  echo "::group::Diagnosis $id"
  timeout "${FLAKE_HUNT_TIMEOUT:-20m}" claude "${args[@]}" "$(cat "$prompt")" > "$answer"
  status=$?
  echo "::endgroup::"

  if [ "$status" -eq 0 ] && [ -s "$answer" ]; then
    mv "$answer" "$out/$id.md"
    echo "Diagnosis $id: done"
  else
    rm -f "$answer"
    echo "::warning::Diagnosis $id failed (exit $status); its issue goes out without one."
  fi

  # Ignored files (deps, _build) stay; the tools checkout isn't ignored.
  git -C "$repo" checkout -q -- .
  git -C "$repo" clean -q -fd -e .flake-hunt
done
