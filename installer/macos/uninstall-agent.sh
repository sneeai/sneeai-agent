#!/bin/sh
set -eu

remove_data=0
if [ "${1:-}" = "--remove-data" ]; then
  remove_data=1
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--remove-data]" >&2
  exit 2
fi

target_uid="$(/usr/bin/id -u)"
target_home="$HOME"
plist="$target_home/Library/LaunchAgents/com.sneeai.agent.plist"
install_directory="$target_home/Library/Application Support/SneeAI/Agent"

/bin/launchctl bootout "gui/$target_uid/com.sneeai.agent" >/dev/null 2>&1 || true
/bin/rm -f "$plist"
/bin/rm -rf "$install_directory"
if [ "$remove_data" -eq 1 ]; then
  /bin/rm -rf "$target_home/.sneeai-agent"
fi
echo "SneeAI Agent was removed."
