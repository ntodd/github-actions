#!/usr/bin/env bash
# Picks the Elixir and OTP versions for setup-beam and writes them to
# $GITHUB_OUTPUT as elixir= and otp=.
#
#   versions.sh <project dir> <repo root>
#
# FLAKE_HUNT_ELIXIR and FLAKE_HUNT_OTP (the workflow's inputs) win.
# Otherwise each comes from the first of these that names it:
#   <project>/mise.toml, <project>/.tool-versions, <root>/mise.toml, <root>/.tool-versions
# mise's "1.20.4-otp-29" style is cut to "1.20.4": setup-beam adds the OTP
# part itself.
set -euo pipefail

project=${1:-.}
root=${2:-.}
elixir=${FLAKE_HUNT_ELIXIR:-}
otp=${FLAKE_HUNT_OTP:-}

# The tool's version from mise.toml's [tools] table, if it's a plain string.
from_mise() {
  awk -v tool="$2" '
    /^[[:space:]]*\[/ { tools = ($0 ~ /^[[:space:]]*\[tools\][[:space:]]*$/); next }
    tools {
      line = $0
      if (match(line, "^[[:space:]]*\"?" tool "\"?[[:space:]]*=[[:space:]]*\"")) {
        rest = substr(line, RSTART + RLENGTH)
        sub(/".*/, "", rest)
        print rest
        exit
      }
    }' "$1"
}

from_tool_versions() {
  awk -v tool="$2" '$1 == tool { print $2; exit }' "$1"
}

for dir in "$project" "$root"; do
  for f in mise.toml .mise.toml; do
    if [ -f "$dir/$f" ]; then
      [ -n "$elixir" ] || elixir=$(from_mise "$dir/$f" elixir)
      [ -n "$otp" ] || otp=$(from_mise "$dir/$f" erlang)
    fi
  done
  if [ -f "$dir/.tool-versions" ]; then
    [ -n "$elixir" ] || elixir=$(from_tool_versions "$dir/.tool-versions" elixir)
    [ -n "$otp" ] || otp=$(from_tool_versions "$dir/.tool-versions" erlang)
  fi
done

elixir=${elixir%-otp-*}
if [ -z "$elixir" ] || [ -z "$otp" ]; then
  echo "::error::Couldn't find the Elixir and Erlang versions in mise.toml or .tool-versions. Set the elixir-version and otp-version inputs."
  exit 1
fi

echo "Elixir $elixir, OTP $otp"
{
  echo "elixir=$elixir"
  echo "otp=$otp"
} >> "${GITHUB_OUTPUT:?}"
