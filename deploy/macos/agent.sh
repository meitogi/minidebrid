#!/bin/sh
# debrid-remote server under launchd on macOS : start at login, restart if it dies.
# Usage (from the repo root) : sh deploy/macos/agent.sh install|uninstall|start|stop|status|logs [-n N] [-f]
# Test overrides owned by this script : DEBRID_AGENT_OS (instead of uname -s),
# DEBRID_AGENT_LAUNCHCTL (instead of launchctl), NODE_BIN (instead of the node on PATH).

set -eu

LABEL=boo.ranchchoco.debrid-remote
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
SERVER="$ROOT/server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/debrid-remote.log"
LAUNCHCTL=${DEBRID_AGENT_LAUNCHCTL:-launchctl}
DOMAIN="gui/$(id -u)"
FW=/usr/libexec/ApplicationFirewall/socketfilterfw

die() { echo "agent: $*" >&2; exit 1; }

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

loaded() { "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# bootout returns before launchd has torn the job down ; a bootstrap right after fails with 5 (I/O error).
unload() {
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
  i=0
  while loaded && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
}

http_port() {
  p=$(sed -n 's/^[[:space:]]*HTTP_PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*/\1/p' "$SERVER/.env" | tail -n 1)
  echo "${p:-8098}"
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml "$1")</string>
		<string>src/index.js</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml "$SERVER")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml "$LOG")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
  mv "$PLIST.tmp" "$PLIST"
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

  write_plist "$node"
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
  cat <<EOF
Next : wtf debrid agent status   (expect : running, pid …)
       wtf debrid agent logs     (expect : http: listening on :$(http_port), relay: connected, peerId=srv-…)
After a node upgrade (nvm install, brew upgrade), run install again : the plist
and the firewall entry both name this exact node binary.
EOF
}

uninstall() {
  unload
  rm -f "$PLIST"
  echo "uninstalled $LABEL — server/.env and $LOG left in place"
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
