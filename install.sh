#!/usr/bin/env bash
# agent-mailbox installer. Safe to re-run: it updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/jah2488/agent-mailbox/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --relay https://your-relay.example [--name "Your Name"]
#
# Installs the code into ~/.local/share/agent-mailbox, links `mailbox` into
# ~/.local/bin, registers the MCP server and the inbox hook with Claude Code
# (a backup of settings.json is kept beside it), then runs `mailbox setup`,
# which asks for your relay and your name (each skipped when passed as a
# flag) and creates your identity and your daemon's certified key. It never
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

# Color only for a terminal that wants it; logs and pipes get plain text.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then color=1; else color=0; fi
paint() { if [ "$color" = 1 ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
bold() { paint "1" "$1"; }
dim() { paint "2" "$1"; }
cmd() { paint "1;38;5;87" "$1"; }

step() { printf '  %s %s\n' "$(paint "38;5;141" "◆")" "$1"; }
ok() { printf '  %s %s  %s\n' "$(paint "1;38;5;48" "✓")" "$1" "$(dim "${2:-}")"; }
warn() { printf '  %s %s\n' "$(paint "1;38;5;214" "⚠")" "$1" >&2; }
fail() { printf '  %s %s\n' "$(paint "1;38;5;203" "✗")" "$1" >&2; exit 1; }

# The name, one letter per color, across the same purple-to-cyan sweep as the logo.
title() {
  local text="agent-mailbox" colors=(93 129 165 201 207 213 177 141 105 69 75 81 87) out="" i
  for ((i = 0; i < ${#text}; i++)); do out+="$(paint "1;38;5;${colors[i]}" "${text:i:1}")"; done
  printf '\n  %s %s\n  %s\n\n' "$(paint "38;5;230" "✦")" "$out" "$(dim "signed, encrypted mail between your team's agents")"
}

title
[ "$(uname -s)" = "Darwin" ] || warn "Built and tested on macOS only (Keychain, launchd)."
command -v git > /dev/null || fail "git is required."
command -v node > /dev/null || fail "Node.js 22.18 or newer is required: https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || fail "Node.js 22.18 or newer is required; this is $(node -v)."

if [ -d "$dir/.git" ]; then
  step "Updating"
  git -C "$dir" pull --ff-only --quiet
  ok "Code up to date" "$dir"
else
  step "Downloading"
  mkdir -p "$(dirname "$dir")"
  git clone --quiet --depth 1 "$repo" "$dir"
  ok "Code installed" "$dir"
fi
step "Installing dependencies"
(cd "$dir" && npm ci --omit=dev --no-audit --no-fund --no-progress --no-update-notifier --loglevel=error > /dev/null)
ok "Dependencies installed"

mkdir -p "$bin_dir"
ln -sf "$dir/bin/mailbox" "$bin_dir/mailbox"
mailbox="$bin_dir/mailbox"
ok "Command ready" "$bin_dir/mailbox"

if command -v claude > /dev/null; then
  if claude mcp get agent-mailbox > /dev/null 2>&1; then
    ok "Claude Code already has the mailbox tools"
  else
    claude mcp add --scope user agent-mailbox -- node "$dir/src/mcp-main.ts" > /dev/null
    ok "Mailbox tools added to Claude Code"
  fi
  # Without it, replies wait unseen until someone asks to check the mailbox.
  "$mailbox" hook install > /dev/null
  ok "Inbox hook on" "new mail is mentioned at your next prompt; every send asks you first"
else
  warn "Claude Code not found. Once it's installed, run: claude mcp add --scope user agent-mailbox -- node $dir/src/mcp-main.ts"
fi

printf '\n  %s\n\n' "$(bold "Your identity")"
setup_args=()
[ -n "$relay" ] && setup_args+=(--relay "$relay")
[ -n "$name" ] && setup_args+=(--name "$name")
# Under curl | bash, stdin is this script, so the wizard reads the terminal directly.
# The guarded expansion keeps macOS's bash 3.2 happy with an empty list under set -u.
if (exec < /dev/tty) 2> /dev/null; then
  "$mailbox" setup ${setup_args[@]+"${setup_args[@]}"} < /dev/tty
else
  "$mailbox" setup ${setup_args[@]+"${setup_args[@]}"}
fi

echo
ok "$(bold "Installed.")"
case ":$PATH:" in *":$bin_dir:"*) ;; *) warn "Add $bin_dir to your PATH to run mailbox by name." ;; esac
printf '\n  %s\n' "$(bold "Everyday commands")"
printf '    %s   %s\n' "$(cmd "mailbox invite       ")" "copy the command a teammate runs to add you"
printf '    %s   %s\n' "$(cmd "mailbox status       ")" "who you are, and what's running"
printf '    %s   %s\n' "$(cmd "mailbox daemon start ")" "let your agent answer while you're busy (off: mailbox daemon stop)"
printf '    %s   %s\n' "$(cmd "mailbox review       ")" "what's waiting on you"
printf '    %s   %s\n' "$(cmd "mailbox update       ")" "get the latest version"
printf '    %s   %s\n' "$(cmd "mailbox uninstall    ")" "remove everything"
printf '\n  %s\n\n' "$(paint "1;38;5;214" "Restart Claude Code so it picks up the mailbox tools.")"
