#!/usr/bin/env bash
set -e

echo "======================================================="
echo "   🚀 Antigravity Mobile Remote - Linux / macOS Setup"
echo "======================================================="

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ خطا: Node.js بر روی سیستم شما نصب نیست."
  echo "لطفا Node.js (نسخه ۱۸ یا بالاتر) را نصب کنید:"
  echo "  - اوبونتو / دبیان: sudo apt update && sudo apt install nodejs npm"
  echo "  - آرچ / Omarchy:   sudo pacman -S nodejs npm"
  echo "  - یا از طریق nvm / fnm / mise"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/scripts/installer.js"
