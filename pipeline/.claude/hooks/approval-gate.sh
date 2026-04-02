#!/bin/bash
#
# Pipeline Approval Gate (Hardened v2)
#
# Per-agent permission enforcement. Auto mode handles general safety.
# This hook handles pipeline-specific rules with DENY-BY-DEFAULT.
#
# LIMITATIONS: This hook prevents agents from accidentally exceeding their role.
# It is NOT a security sandbox. A sufficiently adversarial agent could bypass
# bash-level grep filters via indirect execution. For true isolation, use
# OS-level sandboxing (containers, chroot, etc).
#
# AGENT S (Supervisor): Read unrestricted. Write/Edit jailed to ~/Builds/. Bash allowed.
# AGENT A (Planner):    Can only write plan.md in current project. No Bash. No Agent tool.
# AGENT B (Reviewer):   Cannot write anything. No Bash. No Agent tool.
# AGENT C (Coder):      Can write in current project except plan.md and .claude/. No Agent tool.
# AGENT D (Tester):     Cannot write anything. No Agent tool.
#
# ALL: Write/Edit outside ~/Builds/ blocked. .claude/ paths blocked for all agents.
# MODES: fast=default autonomy, strict=require approval for all C/D Bash calls.
# DEFAULT: DENY (any unrecognized tool is blocked, not allowed)
#

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
CWD=$(echo "$INPUT" | jq -r '.cwd')

# Canonicalize BUILDS_DIR to handle symlinks in $HOME
BUILDS_DIR=$(readlink -f "$HOME/Builds" 2>/dev/null || echo "$HOME/Builds")
AGENT="${PIPELINE_AGENT:-unknown}"
SECURITY_MODE="${PIPELINE_SECURITY_MODE:-fast}"

lower_path() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# ── Reject empty/malformed tool name ─────────────────────────────────

if [ -z "$TOOL_NAME" ] || [ "$TOOL_NAME" = "null" ]; then
  echo "BLOCKED: Could not parse tool name" >&2
  exit 2
fi

# ── Reject unknown agent identity ────────────────────────────────────

if [[ ! "$AGENT" =~ ^[ABCDS]$ ]]; then
  echo "BLOCKED: Unknown agent identity '$AGENT'" >&2
  exit 2
fi

# ── Auto-approve read-only tools (all agents) ────────────────────────

case "$TOOL_NAME" in
  Read|Glob|Grep|ToolSearch|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput|LSP|StructuredOutput)
    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
    ;;
esac

# ── Block Agent tool for ALL agents ──────────────────────────────────

if [ "$TOOL_NAME" = "Agent" ]; then
  echo "BLOCKED: Agent $AGENT cannot spawn sub-agents" >&2
  exit 2
fi

# ── Gate WebFetch and WebSearch (egress risk) ────────────────────────

if [ "$TOOL_NAME" = "WebFetch" ] || [ "$TOOL_NAME" = "WebSearch" ]; then
  # Only allow research-stage web access for agents that need source verification.
  if [[ "$AGENT" =~ ^[AB]$ ]]; then
    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
  fi
  echo "BLOCKED: Agent $AGENT cannot use $TOOL_NAME" >&2
  exit 2
fi

# ── Helper: resolve and validate file path ───────────────────────────

resolve_filepath() {
  local fp="$1"
  # Make absolute
  if [[ "$fp" != /* ]]; then
    fp="$CWD/$fp"
  fi
  # Reject .. in paths
  if [[ "$fp" == *".."* ]]; then
    echo "BLOCKED"
    return
  fi
  # Resolve directory symlinks
  local dir_resolved
  dir_resolved=$(cd "$(dirname "$fp")" 2>/dev/null && pwd -P)
  if [ -z "$dir_resolved" ]; then
    echo "BLOCKED"
    return
  fi
  fp="$dir_resolved/$(basename "$fp")"
  # Resolve file-level symlinks (NOTE: does not detect hardlinks — known limitation)
  if [ -e "$fp" ]; then
    local resolved
    resolved=$(readlink -f "$fp" 2>/dev/null)
    if [ -n "$resolved" ]; then
      fp="$resolved"
    fi
  fi
  echo "$fp"
}

find_project_root() {
  local check="$CWD"
  while [ "$check" != "/" ]; do
    if [ -f "$check/pipeline-events.json" ]; then
      printf '%s\n' "$check"
      return
    fi
    check=$(dirname "$check")
  done
  printf '%s\n' "$CWD"
}

# ── Per-agent Write/Edit/NotebookEdit rules ──────────────────────────

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit)
    FILEPATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    FILEPATH=$(resolve_filepath "$FILEPATH")

    if [ "$FILEPATH" = "BLOCKED" ]; then
      echo "BLOCKED: Invalid file path" >&2
      exit 2
    fi

    FILENAME=$(basename "$FILEPATH")
    BUILDS_DIR_CI=$(lower_path "$BUILDS_DIR")
    FILEPATH_CI=$(lower_path "$FILEPATH")

    # Must be inside ~/Builds/ (with trailing slash)
    if [[ "$FILEPATH_CI" != "$BUILDS_DIR_CI/"* ]]; then
      echo "BLOCKED: Cannot write to $FILEPATH — outside ~/Builds/" >&2
      exit 2
    fi

    # Jail non-S agents to the current project directory (CWD), not all of ~/Builds/
    if [ "$AGENT" != "S" ]; then
      PROJECT_DIR=$(readlink -f "$CWD" 2>/dev/null || echo "$CWD")
      PROJECT_DIR_CI=$(lower_path "$PROJECT_DIR")
      if [[ "$PROJECT_DIR_CI" == "$BUILDS_DIR_CI/"* ]] && [[ "$FILEPATH_CI" != "$PROJECT_DIR_CI/"* ]]; then
        echo "BLOCKED: Cannot write to $FILEPATH — outside current project" >&2
        exit 2
      fi
    fi

    # Block writes to .claude/ for ALL agents (including S)
    case "$FILEPATH" in
      */.claude/*|*/.claude)
        echo "BLOCKED: Cannot modify hook/settings files" >&2
        exit 2
        ;;
    esac

    # Phase 0 check for A — default to BLOCKED if events file missing
    if [ "$AGENT" = "A" ]; then
      EVENTS_FILE=""
      CHECK="$CWD"
      while [ "$CHECK" != "/" ]; do
        if [ -f "$CHECK/pipeline-events.json" ]; then
          EVENTS_FILE="$CHECK/pipeline-events.json"
          break
        fi
        CHECK=$(dirname "$CHECK")
      done
      CURRENT_PHASE="concept"
      if [ -n "$EVENTS_FILE" ]; then
        CURRENT_PHASE=$(jq -r '.currentPhase // "concept"' "$EVENTS_FILE" 2>/dev/null || echo "concept")
      fi
      if [ "$CURRENT_PHASE" = "concept" ]; then
        echo "BLOCKED: Agent A cannot write during Phase 0" >&2
        exit 2
      fi
    fi

    # Agent-specific write rules
    case "$AGENT" in
      S)
        # S can write inside ~/Builds/ but not .claude/ (already checked above)
        ;;
      A)
        if [[ "$FILENAME" != "plan.md" ]]; then
          echo "BLOCKED: Agent A can only write plan.md, not $FILENAME" >&2
          exit 2
        fi
        ;;
      B)
        echo "BLOCKED: Agent B cannot write files" >&2
        exit 2
        ;;
      C)
        if [[ "$FILENAME" == "plan.md" ]]; then
          echo "BLOCKED: Agent C cannot modify plan.md — it is locked" >&2
          exit 2
        fi
        ;;
      D)
        echo "BLOCKED: Agent D cannot write files" >&2
        exit 2
        ;;
    esac

    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
    ;;
esac

# ── Per-agent Bash rules ─────────────────────────────────────────────

if [ "$TOOL_NAME" = "Bash" ]; then
  case "$AGENT" in
    A)
      echo "BLOCKED: Agent A cannot run commands" >&2
      exit 2
      ;;
    B)
      echo "BLOCKED: Agent B cannot run commands" >&2
      exit 2
      ;;
  esac

  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
  PROJECT_ROOT=$(find_project_root)
  APPROVED_BASH_FILE="$PROJECT_ROOT/pipeline-approved-bash.json"

  # Block any command referencing .claude, hooks, or settings
  case "$COMMAND" in
    *".claude"*|*"approval-gate"*|*"settings.json"*|*"hooks/"*)
      echo "BLOCKED: Cannot modify hook or settings files via Bash" >&2
      exit 2
      ;;
  esac

  # Block mv/cp/rm with any glob that could target .claude (e.g., .c*, .cl*)
  # Block these commands entirely when they contain glob wildcards near dot-files
  case "$COMMAND" in
    *"mv "*"."*"*"*|*"cp "*"."*"*"*|*"rm "*"."*"*"*)
      echo "BLOCKED: Cannot mv/cp/rm with glob patterns on dot-files" >&2
      exit 2
      ;;
    *"mv ."*|*"cp ."*|*"rm ."*|*"rm -"*" ."*)
      echo "BLOCKED: Cannot mv/cp/rm dot-files or dot-directories" >&2
      exit 2
      ;;
  esac

  # Block ln entirely — prevents hardlink and symlink bypasses
  case "$COMMAND" in
    *"ln "*|"ln "*|*";ln "*|*"&&ln "*|*"|ln "*|*'$(ln'*|*'`ln'*)
      echo "BLOCKED: Cannot create links via Bash" >&2
      exit 2
      ;;
  esac

  # Block direct claude invocations and PIPELINE_AGENT manipulation
  # NOTE: Indirect execution (python3 -c, eval, base64) is a KNOWN LIMITATION
  # that cannot be solved with bash pattern matching. See SECURITY.md.
  case "$COMMAND" in
    *"PIPELINE_AGENT"*|*"claude -"*|*"claude --"*)
      echo "BLOCKED: Cannot spawn Claude sessions or modify agent identity via Bash" >&2
      exit 2
      ;;
  esac

  # In strict mode, all Bash from C/D requires explicit user approval.
  if [ "$SECURITY_MODE" = "strict" ] && { [ "$AGENT" = "C" ] || [ "$AGENT" = "D" ]; }; then
    if [ -f "$APPROVED_BASH_FILE" ]; then
      GRANT_AGENT=$(jq -r '.agent // ""' "$APPROVED_BASH_FILE" 2>/dev/null || echo "")
      GRANT_COMMAND=$(jq -r '.command // ""' "$APPROVED_BASH_FILE" 2>/dev/null || echo "")
      if [ "$GRANT_AGENT" = "$AGENT" ] && [ "$GRANT_COMMAND" = "$COMMAND" ]; then
        rm -f "$APPROVED_BASH_FILE" 2>/dev/null || true
        echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
        exit 0
      fi
    fi

    jq -n --arg reason "Strict mode: Agent $AGENT Bash requires approval" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
  fi

  # C, D, S: auto mode handles remaining bash safety in fast mode
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# ── DENY BY DEFAULT ──────────────────────────────────────────────────
# Any tool not explicitly handled above is BLOCKED.

echo "BLOCKED: Tool '$TOOL_NAME' is not allowed for Agent $AGENT" >&2
exit 2
