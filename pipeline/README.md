# Pipeline

The orchestrator, agent roles, hooks, and templates that power The Dev Squad's supervisor-led dev team.

See the [main README](../README.md) for the product overview and [SUPERVISOR-BUILD-PLAN.md](../SUPERVISOR-BUILD-PLAN.md) for the current supervisor/operator build direction.

The key idea is that this folder contains the team's shared operating system:

- role files for the supervisor and specialists
- the master build plan template
- the shared checklist
- the hook guardrails that keep the team disciplined
- the orchestrator logic behind `plan-only`, `stop after review`, and stalled-turn recovery

## Files

- `orchestrator.ts` — Spawns agent sessions, routes signals, enforces pipeline flow, and handles supervisor pause/resume controls
- `.claude/hooks/approval-gate.sh` — Per-agent permission enforcement
- `.claude/settings.json` — Hook configuration
- `role-a.md` through `role-s.md` — Agent role context files
- `role-a-phase0.md` — Phase 0 concept discussion context for Agent A
- `build-plan-template.md` — Template that Agent A follows when writing plans
- `checklist-template.md` — Pipeline checklist copied to each build
- `pipelinebuildarchitecture.md` — Full architecture specification
