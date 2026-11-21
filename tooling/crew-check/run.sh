#!/usr/bin/env bash
# Runs crew_check.py with an isolated Kiro Crew home (KIRO_HOME=<data home>/kiro is Crew's isolated-instance recipe). Usage: tooling/crew-check/run.sh [python-with-kiro_crew]
set -euo pipefail
PY="${1:-python3}"
tmp="$(mktemp -d)"
trap '[ -n "${KEEP_CREW_HOME:-}" ] || rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/crew"
HOME="$tmp/home" KIROCREW_HOME="$tmp/crew" KIRO_HOME="$tmp/crew/kiro" "$PY" "$(dirname "$0")/crew_check.py"
