#!/usr/bin/env bash
# Runs the setup input ($FLAKE_HUNT_SETUP) with bash -euo pipefail.
#
# Each NAME=value line of $FLAKE_HUNT_SETUP_SECRETS (the SETUP_SECRETS
# secret) is masked in the log and exported to the script, and to nothing
# after it, unless the script writes it to $GITHUB_ENV. Blank lines are
# skipped. A line that isn't NAME=value fails the step without being
# printed.
set -euo pipefail

if [ -n "${FLAKE_HUNT_SETUP_SECRETS:-}" ]; then
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [ -z "$line" ] && continue
    name=${line%%=*}
    if [ "$name" = "$line" ] || ! [[ $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Line $n of SETUP_SECRETS isn't NAME=value." >&2
      exit 1
    fi
    value=${line#*=}
    [ -n "$value" ] && echo "::add-mask::$value"
    export "$name=$value"
  done <<<"$FLAKE_HUNT_SETUP_SECRETS"
fi
unset FLAKE_HUNT_SETUP_SECRETS

exec bash -euo pipefail -c "$FLAKE_HUNT_SETUP"
