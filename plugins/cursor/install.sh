#!/usr/bin/env bash
# install.sh — invoked by `memfork install-cursor`.
# Installs the MemForks rule and hooks into the current project's .cursor/ dir.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-$(pwd)}"

CURSOR_DIR="$PROJECT_ROOT/.cursor"
RULES_DIR="$CURSOR_DIR/rules"
HOOKS_DIR="$CURSOR_DIR/hooks"

echo "Installing MemForks Cursor plugin into: $PROJECT_ROOT"

# ─── Rules ────────────────────────────────────────────────────────────────────

mkdir -p "$RULES_DIR"
cp "$PLUGIN_DIR/rules/memforks.mdc" "$RULES_DIR/memforks.mdc"
echo "  ✓ Installed rule: .cursor/rules/memforks.mdc"

# ─── Hooks ────────────────────────────────────────────────────────────────────

mkdir -p "$HOOKS_DIR"

# Merge with existing hooks.json if present.
EXISTING_HOOKS="$CURSOR_DIR/hooks.json"
PLUGIN_HOOKS="$PLUGIN_DIR/hooks/hooks.json"

if [ -f "$EXISTING_HOOKS" ]; then
  python3 - <<'PYEOF' "$EXISTING_HOOKS" "$PLUGIN_HOOKS" "$CURSOR_DIR/hooks.json"
import json, sys

existing_path, plugin_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(existing_path) as f:
    existing = json.load(f)
with open(plugin_path) as f:
    plugin = json.load(f)

merged = existing.copy()
merged.setdefault("version", 1)
for event, hooks in plugin.get("hooks", {}).items():
    merged.setdefault("hooks", {}).setdefault(event, [])
    # Avoid duplicate entries.
    existing_cmds = {h.get("command") for h in merged["hooks"][event]}
    for hook in hooks:
        if hook.get("command") not in existing_cmds:
            merged["hooks"][event].append(hook)

with open(out_path, "w") as f:
    json.dump(merged, f, indent=2)
PYEOF
  echo "  ✓ Merged hooks into: .cursor/hooks.json"
else
  cp "$PLUGIN_HOOKS" "$EXISTING_HOOKS"
  echo "  ✓ Installed hooks: .cursor/hooks.json"
fi

# Copy the hook scripts.
cp "$PLUGIN_DIR/hooks/memforks-session-start.sh" "$HOOKS_DIR/memforks-session-start.sh"
cp "$PLUGIN_DIR/hooks/memforks-stop.sh"          "$HOOKS_DIR/memforks-stop.sh"
chmod +x "$HOOKS_DIR"/memforks-*.sh
echo "  ✓ Installed hook scripts: .cursor/hooks/memforks-*.sh"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "MemForks Cursor plugin installed."
echo ""
echo "Next steps:"
echo "  1. Set env vars: MEMFORK_TREE_ID, MEMFORK_PRIVATE_KEY, MEMFORK_MEMWAL_ACCOUNT, MEMFORK_MEMWAL_KEY"
echo "  2. Reload Cursor (or it will pick up the hooks automatically)"
echo "  3. Start a new session — MemForks will recall your branch memory on load"
