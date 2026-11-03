#!/usr/bin/env bash
# agent-mailbox installer. Safe to re-run: it updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/jah2488/agent-mailbox/main/install.sh | bash -s -- --name "Your Name" --relay https://your-relay.example
#
# Installs the code into ~/.local/share/agent-mailbox, links `mailbox` into
# ~/.local/bin, registers the MCP server and the inbox hook with Claude Code
# (a backup of settings.json is kept beside it), and (with --name and
# --relay) creates your identity and your daemon's certified key. It never
# starts the daemon: that is `mailbox daemon start`, and `mailbox daemon stop`
# turns it off. `mailbox uninstall` reverses all of this.
set -euo pipefail

repo="${AGENT_MAILBOX_REPO:-https://github.com/jah2488/agent-mailbox.git}"
dir="${AGENT_MAILBOX_DIR:-$HOME/.local/share/agent-mailbox}"
bin_dir="$HOME/.local/bin"
name=""
relay=""

while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --relay) relay="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'agent-mailbox install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || echo "warning: built and tested on macOS only (Keychain, launchd)" >&2
command -v git > /dev/null || fail "git is required"
command -v node > /dev/null || fail "Node.js 22.18 or newer is required (https://nodejs.org)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || fail "Node.js 22.18 or newer is required; this is $(node -v)"

if [ -d "$dir/.git" ]; then
  say "Updating $dir"
  git -C "$dir" pull --ff-only --quiet
else
  say "Installing into $dir"
  mkdir -p "$(dirname "$dir")"
  git clone --quiet --depth 1 "$repo" "$dir"
fi
(cd "$dir" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

mkdir -p "$bin_dir"
ln -sf "$dir/bin/mailbox" "$bin_dir/mailbox"
mailbox="$bin_dir/mailbox"

if command -v claude > /dev/null; then
  if claude mcp get agent-mailbox > /dev/null 2>&1; then
    say "Claude Code already has the agent-mailbox MCP server"
  else
    claude mcp add --scope user agent-mailbox -- node "$dir/src/mcp-main.ts" > /dev/null
    say "Registered the agent-mailbox MCP server with Claude Code"
  fi
  # Without it, replies wait unseen until someone asks to check the mailbox.
  "$mailbox" hook install
else
  echo "warning: claude not found; once it is installed, run: claude mcp add --scope user agent-mailbox -- node $dir/src/mcp-main.ts" >&2
fi

if [ -n "$name" ] && [ -n "$relay" ]; then
  if "$mailbox" whoami > /dev/null 2>&1; then
    say "You already have an identity; keeping it"
  else
    "$mailbox" keygen --name "$name" --relay "$relay" > /dev/null
  fi
  "$mailbox" daemon setup > /dev/null
  say "Identity and daemon key ready"
fi

echo
say "Installed."
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to your PATH to run mailbox by name." ;; esac
if "$mailbox" whoami > /dev/null 2>&1; then
  echo "Send this line to each teammate, and read them your fingerprint on a call:"
  "$mailbox" whoami | sed 's/^/  /'
else
  echo "Create your identity: mailbox keygen --name \"Your Name\" --relay <relay url>, then mailbox daemon setup"
fi
cat <<'EOF'
Add a teammate:     mailbox peer add '<their line>' --fingerprint "<what they read you>"
Daemon on / off:    mailbox daemon start   /   mailbox daemon stop
What needs you:     mailbox review
Remove everything:  mailbox uninstall
Restart Claude Code to pick up the MCP server.
EOF
