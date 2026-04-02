# Security

## Threat Model

The hook system prevents agents from **accidentally drifting out of their lane** during normal pipeline operation. It is NOT a security sandbox against adversarial or jailbreak-prone models.

If your threat model requires defense against a hostile agent, you need OS-level isolation (containers, chroot, seccomp) — not a bash hook.

The concrete implementation plan for getting there lives in [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md).

This project is provided `AS IS` under the MIT license. Users are responsible for reviewing approvals, protecting secrets, and deciding whether the documented limitations are acceptable for their environment.

## Hook Enforcement Model

Agent permissions are enforced by a `PreToolUse` hook (`pipeline/.claude/hooks/approval-gate.sh`), not by prompts. The hook runs before every tool call for every agent. Prompts provide context — the hook provides guardrails.

Run `pnpm test:hook` after changing the orchestrator or hook rules. It verifies the expected agent/tool contract so hook drift is caught before it reaches a live pipeline run.

## What the Hook Catches

The hook reliably prevents:

- **Accidental `Write`/`Edit`/`NotebookEdit` outside `~/Builds/`** — path prefix check with trailing slash, canonicalized via `readlink -f`
- **Accidental writes to `.claude/` config via file-edit tools** — case pattern blocks `Write`/`Edit`/`NotebookEdit` to `.claude/` paths
- **Agent A writing code files via file-edit tools** — only `plan.md` allowed
- **Agents B and D writing via file-edit tools** — all `Write`/`Edit`/`NotebookEdit` calls blocked
- **Agent C modifying `plan.md` via file-edit tools** — locked after review
- **Agents A and B running Bash** — blocked entirely
- **Any agent spawning sub-agents** — Agent tool blocked for all
- **Path traversal via `..`** — rejected before resolution
- **Unknown agent identity** — rejected if not A/B/C/D/S
- **Unrecognized tools** — deny-by-default catch-all
- **Missing/malformed tool names** — rejected on parse
- **Phase 0 writes by Agent A** — blocked, defaults to blocked if events file missing
- **Symlink-based path escapes** — resolved via `readlink -f`
- **`cd`-then-`Write` drift across Bash commands** — mitigated by setting `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, which resets Claude's working directory after each Bash command

## What the Hook Does NOT Catch

These are known, documented limitations that cannot be fully solved with a bash hook:

**Indirect execution bypass (V3 — OPEN)**
Agents with Bash access (C, D, S) can use `python3 -c`, `eval`, `base64`, or other indirect methods to invoke Claude or modify files in ways the pattern filters don't catch. The hook blocks direct `claude -p` and `PIPELINE_AGENT` strings, but cannot prevent all forms of indirect execution. This is fundamentally a blocklist-vs-allowlist problem — you cannot enumerate every way to invoke a program from bash.

**Hardlink bypass (V2/V4 — PARTIALLY MITIGATED)**
The hook blocks `ln` commands and resolves symlinks via `readlink -f`, but `readlink -f` does not detect hardlinks. If a hardlink to an external file exists inside `~/Builds/`, the hook will allow writes to it. The `ln` block prevents agents from creating new hardlinks, but cannot detect pre-existing ones. Creating hardlinks via indirect execution (python, etc.) is also possible.

**Glob-based `.claude/` bypass (V1 — PARTIALLY MITIGATED)**
The hook blocks `mv`/`cp`/`rm` with dot-file glob patterns and direct `.claude` references. However, sufficiently creative glob patterns or indirect shell expansion could evade the filters. Moving the hook outside the agent-writable tree would be the correct fix.

**Cross-project writes via Bash (OPEN)**
Agents A-D are now jailed to their current project directory for `Write`/`Edit`/`NotebookEdit`, and pipeline sessions set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` so a Bash `cd` does not persist into later file-edit tool calls. However, Bash itself remains a direct write channel for agents C, D, and S. Agent C can still write to sibling projects with shell redirection in a single Bash command, and agent D can still write via Bash despite being read-only at the file-edit-tool layer.

**TOCTOU race conditions**
The hook resolves file paths at check time. Between the check and the actual tool execution, symlinks could be retargeted. This is a fundamental limitation of check-then-act in a separate process.

**Research-stage web egress (ACCEPTED RISK)**
Agents A and B have `WebSearch` and `WebFetch` access for direct-source research and review. This improves plan quality and verification quality, but it also means those agents can send queries and fetch external pages. That is an accepted tradeoff for the planning/review stages. Agents C, D, and S remain blocked from `WebSearch` and `WebFetch`.

## What Requires What

Docker is one way to get stronger isolation, but it is not the only way. Containers, chroot jails, VMs, macOS App Sandbox, or other OS-enforced isolation can all serve the same role.

| Issue | Fixable in Hook? | Needs Design / Permission Change? | Needs OS Isolation for Strong Guarantee? |
|-------|------------------|-----------------------------------|------------------------------------------|
| Cross-project writes via `Write`/`Edit`/`NotebookEdit` | Yes — **FIXED** | No | No |
| Cross-project writes via Bash | No | Yes — gate all Bash for C/D, remove Bash, or replace it with allowlisted operations | Yes, if unrestricted Bash must remain available |
| Agent A/B research-stage web egress | No | Yes — reduce, proxy, gate, or remove web access | No |
| Indirect execution via `python3 -c`, `eval`, base64, etc. | No | Yes — remove Bash, require approval for all Bash, or replace shell access with allowlisted operations | Yes, if Bash must remain available |
| Hardlink bypass | Partial mitigation only | Yes — move protected files out of agent-writable trees and reduce shell/file authority | Yes, if you need a reliable guarantee |
| TOCTOU race between check and tool execution | No | Partial mitigation only | Yes |

In short:

- **Fix in hook:** cross-project writes through `Write`/`Edit`/`NotebookEdit`
- **Fix by changing permissions/product design:** Bash-mediated writes, indirect execution, and research-stage web egress risk
- **Needs OS-level isolation for a strong guarantee:** hardlinks and TOCTOU, and Bash-mediated escapes if Bash remains available

## Current Permission Matrix

The `Write` column below refers to file-edit tools (`Write`, `Edit`, `NotebookEdit`), not shell redirection inside Bash.

| Agent | Read | Write | Bash | WebSearch | WebFetch | Agent Tool |
|-------|------|-------|------|-----------|----------|------------|
| S | Anywhere | `~/Builds/` only (no `.claude/`) | Yes (pattern-restricted) | No | No | No |
| A | Anywhere | `plan.md` only in the current project under `~/Builds/` (no Phase 0) | No | Yes | Yes | No |
| B | Anywhere | No | No | Yes | Yes | No |
| C | Anywhere | Current project under `~/Builds/` (no `plan.md`, no `.claude/`) | Yes (pattern-restricted) | No | No | No |
| D | Anywhere | No | Yes (pattern-restricted) | No | No | No |

Pipeline sessions also set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, which resets Claude's working directory after each Bash command. This mitigates `cd`-then-`Write` drift, but it does not make Bash read-only.

## Recommended Hardening (Future)

The build plan is in [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md). In short:

1. **`v0.3`: Strict mode** — shipped; C/D Bash now supports "approve every call" with request-scoped approval records and one-time grants for the exact approved command
2. **`v0.4`: Sandboxed execution** — run agents in containers or equivalent per-project sandboxes
3. **`v0.5`: Host-owned policy** — move approvals and enforcement outside the repo so agents cannot disable them by editing project files

## Reporting

If you find a security issue, please open a private issue or contact the maintainer directly.
