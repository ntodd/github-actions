#!/usr/bin/env bash
# Installs what the agent needs beyond the runner image: gh with the
# gh-stack extension, Claude Code, Codex and Playwright's MCP server. Then
# writes the MCP config, pointed at a Chromium: the one baked into Crew's
# guest image if it's there, or one Playwright downloads.
#
# Env: AGENT_GH_VERSION, AGENT_GH_STACK_VERSION, AGENT_CLAUDE_VERSION,
# AGENT_CODEX_VERSION, AGENT_PLAYWRIGHT_MCP_VERSION, AGENT_STATE,
# AGENT_MCP_CONFIG, GITHUB_TOKEN (to download the extension).
set -euo pipefail

bin=$HOME/.local/bin
mkdir -p "$bin"
export PATH=$bin:$PATH
[ -n "${GITHUB_PATH:-}" ] && echo "$bin" >>"$GITHUB_PATH"

case "$(uname -m)" in
x86_64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) echo "Unsupported architecture $(uname -m)" >&2 && exit 1 ;;
esac

# gh, checked against its release's checksum. Known versions are pinned
# here; others use the checksums file from the same release.
declare -A gh_sums=(
  [2.102.0-amd64]=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
  [2.102.0-arm64]=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
)
v=$AGENT_GH_VERSION
if ! gh --version 2>/dev/null | grep -q "gh version $v "; then
  tgz=gh_${v}_linux_${arch}.tar.gz
  base=https://github.com/cli/cli/releases/download/v$v
  curl -fsSL -o "/tmp/$tgz" "$base/$tgz"
  sum=${gh_sums[$v-$arch]:-$(curl -fsSL "$base/gh_${v}_checksums.txt" | awk -v f="$tgz" '$2 == f {print $1}')}
  echo "$sum  /tmp/$tgz" | sha256sum -c -
  tar -xzf "/tmp/$tgz" -C /tmp
  install -m 0755 "/tmp/gh_${v}_linux_${arch}/bin/gh" "$bin/gh"
fi
gh --version | head -1
GH_TOKEN=$GITHUB_TOKEN gh extension install github/gh-stack --pin "$AGENT_GH_STACK_VERSION" --force
gh stack --help >/dev/null

curl -fsSL https://claude.ai/install.sh | bash -s -- "$AGENT_CLAUDE_VERSION"
claude --version

npm install --global --no-fund --no-audit "@openai/codex@$AGENT_CODEX_VERSION" "@playwright/mcp@$AGENT_PLAYWRIGHT_MCP_VERSION"
codex --version

chrome=$(compgen -G '/ms-playwright/chromium-*/chrome-linux*/chrome' | head -1 || true)
if [ -z "$chrome" ]; then
  npx --yes "playwright@$(npm view "@playwright/mcp@$AGENT_PLAYWRIGHT_MCP_VERSION" dependencies.playwright)" install --with-deps chromium
  chrome=$(compgen -G "$HOME/.cache/ms-playwright/chromium-*/chrome-linux*/chrome" | head -1)
fi
echo "Chromium: $chrome"

mkdir -p "$AGENT_STATE/playwright" "$(dirname "$AGENT_MCP_CONFIG")"
cat >"$AGENT_MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "playwright-mcp",
      "args": ["--headless", "--isolated", "--executable-path", "$chrome", "--viewport-size", "1280x800", "--output-dir", "$AGENT_STATE/playwright"]
    }
  }
}
EOF
