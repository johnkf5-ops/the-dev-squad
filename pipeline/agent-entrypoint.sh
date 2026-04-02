#!/bin/bash
set -euo pipefail

if [ -n "${AGENT_NETWORK_PROFILE:-}" ]; then
  sudo /usr/local/bin/agent-firewall.sh "$AGENT_NETWORK_PROFILE"
fi

exec "$@"
