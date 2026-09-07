#!/usr/bin/env bash
set -e

# Change directory to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ خطا: Node.js روی سیستم یافت نشد."
  exit 1
fi

node "$SCRIPT_DIR/scripts/tui.js"
