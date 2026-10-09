#!/bin/sh
# debrid-remote server under launchd on macOS : start at login, restart if it dies.
# Usage (from the repo root) : sh deploy/macos/agent.sh install|uninstall|start|stop|status|logs [-n N] [-f]
# install also builds the menu-bar icon (DebridRemoteBar.swift) when swiftc is there.
# Test overrides owned by this script : DEBRID_AGENT_OS (instead of uname -s),
# DEBRID_AGENT_LAUNCHCTL (instead of launchctl), NODE_BIN (instead of the node on PATH).

set -eu

LABEL=boo.ranchchoco.debrid-remote
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
SERVER="$ROOT/server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/debrid-remote.log"
BAR_LABEL=$LABEL.menubar
BAR_PLIST="$HOME/Library/LaunchAgents/$BAR_LABEL.plist"
BAR_BIN="$HOME/Library/Application Support/debrid-remote/DebridRemoteBar"
BAR_LOG="$HOME/Library/Logs/debrid-remote-menubar.log"
LAUNCHCTL=${DEBRID_AGENT_LAUNCHCTL:-launchctl}
DOMAIN="gui/$(id -u)"
FW=/usr/libexec/ApplicationFirewall/socketfilterfw

die() { echo "agent: $*" >&2; exit 1; }

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

loaded() { "$LAUNCHCTL" print "$DOMAIN/${1:-$LABEL}" >/dev/null 2>&1; }

# bootout returns before launchd has torn the job down ; a bootstrap right after fails with 5 (I/O error).
unload() {
  "$LAUNCHCTL" bootout "$DOMAIN/${1:-$LABEL}" >/dev/null 2>&1 || return 0
  i=0
  while loaded "${1:-$LABEL}" && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
}

http_port() {
  p=$(sed -n 's/^[[:space:]]*HTTP_PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$SERVER/.env" | tail -n 1)
  echo "${p:-8098}"
}

# write_plist <plist> <label> <keepalive xml> <working dir> <log> <program> [args…]
write_plist() {
  file=$1 label=$2 keep=$3 dir=$4 out=$5
  shift 5
  args=
  for a in "$@"; do args="$args
		<string>$(xml "$a")</string>"; done
  mkdir -p "$(dirname "$file")" "$(dirname "$out")"
  cat > "$file.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>$args
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml "$dir")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	$keep
	<key>StandardOutPath</key>
	<string>$(xml "$out")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$out")</string>
</dict>
</plist>
EOF
  mv "$file.tmp" "$file"
}

# Quitting the icon is a clean exit : SuccessfulExit false keeps it quit until the next login.
install_menubar() {
  if ! command -v swiftc >/dev/null 2>&1; then
    echo "menu bar : swiftc not found, icon skipped — xcode-select --install, then install again"
    return
  fi
  mkdir -p "$(dirname "$BAR_BIN")"
  # Build beside, then rename : overwriting a signed binary in place gets its next launch killed on arm64.
  if ! swiftc -parse-as-library -O -o "$BAR_BIN.new" "$ROOT/deploy/macos/DebridRemoteBar.swift"; then
    rm -f "$BAR_BIN.new"
    echo "menu bar : build failed (above), icon skipped — the server agent is installed"
    return
  fi
  mv -f "$BAR_BIN.new" "$BAR_BIN"
  write_plist "$BAR_PLIST" "$BAR_LABEL" '<dict><key>SuccessfulExit</key><false/></dict>' "$HOME" "$BAR_LOG" \
    "$BAR_BIN" "$ROOT/deploy/macos/agent.sh" "$LOG"
  unload "$BAR_LABEL"
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$BAR_PLIST"
  echo "menu bar : $BAR_BIN ($BAR_LABEL)"
}

firewall_hint() {
  node=$1
  if [ ! -x "$FW" ]; then
    echo "firewall: socketfilterfw not found, skipped"
  elif "$FW" --getglobalstate 2>/dev/null | grep -q 'State = 0'; then
    echo "firewall: off, nothing to allow"
  elif "$FW" --listapps 2>/dev/null | grep -F -A1 "$node" | grep -q 'Allow incoming'; then
    echo "firewall: $node already allowed"
  else
    cat <<EOF
firewall: $node is not allowed yet — WebRTC would time out after 20 s. Run :
  sudo $FW --add "$node"
  sudo $FW --unblockapp "$node"
EOF
  fi
}

install() {
  case "$ROOT" in
    "$HOME/Downloads"/*|"$HOME/Documents"/*|"$HOME/Desktop"/*)
      die "the repo is in a folder macOS protects ($ROOT) : launchd's node would get 'Operation not permitted'. Move it (e.g. to ~/Developer) and run install again from there." ;;
  esac
  [ -f "$SERVER/.env" ] || die "server/.env missing — create it from server/.env.example first (GUIDE § 1)."
  [ -d "$SERVER/node_modules/werift" ] || die "server dependencies missing — run : npm --prefix server ci"

  node=${NODE_BIN:-$(command -v node || true)}
  [ -n "$node" ] || die "no node on PATH — open the shell where node works, or set NODE_BIN=/path/to/node."
  node=$("$node" -p process.execPath) || die "$node does not run"
  major=$("$node" -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "$node is node $major, the server needs 22 or later."

  if ! loaded && command -v lsof >/dev/null 2>&1; then
    port=$(http_port)
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      die "something already listens on :$port (a foreground 'wtf debrid start' ?). Stop it first : two servers would announce the same peer id."
    fi
  fi

  write_plist "$PLIST" "$LABEL" '<true/>' "$SERVER" "$LOG" "$node" src/index.js
  unload
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"

  cat <<EOF
installed $LABEL
  node   : $node
  server : $SERVER
  plist  : $PLIST
  log    : $LOG
EOF
  firewall_hint "$node"
  install_menubar
  cat <<EOF
Next : wtf debrid agent status   (expect : running, pid …)
       wtf debrid agent logs     (expect : http: listening on :$(http_port), relay: connected, peerId=srv-…)
After a node upgrade (nvm install, brew upgrade), run install again : the plist
and the firewall entry both name this exact node binary.
EOF
}

uninstall() {
  unload "$BAR_LABEL"
  rm -f "$BAR_PLIST" "$BAR_BIN"
  unload
  rm -f "$PLIST"
  echo "uninstalled $LABEL and its menu-bar icon — server/.env and $LOG left in place"
}

start() {
  [ -f "$PLIST" ] || die "not installed — run : wtf debrid agent install"
  if loaded; then
    "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL"
  else
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
  fi
  echo "started $LABEL"
}

stop() {
  unload
  echo "stopped $LABEL — it starts again at the next login, or with : wtf debrid agent start"
}

# First word is the state, read by the menu-bar app : running | crashing | stopped | absent.
status() {
  if ! out=$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null); then
    if [ -f "$PLIST" ]; then echo "stopped"; else echo "absent — not installed"; fi
    return
  fi
  pid=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*pid = \([0-9]*\).*/\1/p' | head -n 1)
  if [ -n "$pid" ]; then
    echo "running pid $pid"
  else
    last=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*last exit code = \(.*\)/\1/p' | head -n 1)
    echo "crashing last exit ${last:-unknown} — see $LOG"
  fi
}

logs() {
  n=50 follow=
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) n=$2; shift 2 ;;
      -f) follow=-f; shift ;;
      *) die "logs : unknown option $1" ;;
    esac
  done
  [ -f "$LOG" ] || die "no log yet ($LOG) — is the agent installed ?"
  exec tail -n "$n" $follow "$LOG"
}

[ "${DEBRID_AGENT_OS:-$(uname -s)}" = Darwin ] || die "macOS only. On Linux the container restarts itself (restart: unless-stopped) : wtf debrid up."

action=${1:-}
[ $# -gt 0 ] && shift
case "$action" in
  install) install ;;
  uninstall) uninstall ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) logs "$@" ;;
  *) die "usage : agent.sh install|uninstall|start|stop|status|logs [-n N] [-f]" ;;
esac
