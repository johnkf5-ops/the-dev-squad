# Architecture

The Dev Squad is Claude with its own dev team. One supervisor. Four specialists. Two modes. Two interfaces. In **Pipeline Mode**, the supervisor can run the team for you while you keep everything in one place. In **Manual Mode**, you are the orchestrator — five Claude sessions with expertise labels, no automation, you direct everything, while Claude Code's own permission prompts still apply inside those direct sessions. The same team can now be used through both the visual Office View and the simpler Supervisor-first Squad View.

## The Team

- **Supervisor (`S`)**: The operator/recovery partner. Reads broadly, explains what the team is doing, and helps the user decide when to wait, stop, retry, or recover.
- **Planner (`A`)**: Chats with the user, researches, writes the build plan, and confirms completion at the end
- **Plan Reviewer (`B`)**: Pokes holes in the plan until there are none left
- **Coder (`C`)**: Follows the approved plan and writes the code
- **Tester (`D`)**: Reviews the code against the plan, then tests it

## Product Direction

The product is moving toward "give Claude a dev team":

- the Supervisor is the human-facing front door
- the Planner, Plan Reviewer, Coder, and Tester are the worker specialists
- the whole team follows the same doctrine: `build-plan-template.md`, `checklist.md`, and the locked `plan.md`

Today, pipeline mode can now start from the **Supervisor** as well as direct planner chat. The supervisor has the first real control-plane actions: saved-session recovery for planning/review turns, `plan-only`, `stop after review`, `continue build` from an approved plan, and chat-triggered start/stop/resume actions. The next implementation step is to keep moving authority toward the supervisor while leaving the actual execution path deterministic in host/orchestrator code. The concrete build plan for that transition lives in [SUPERVISOR-BUILD-PLAN.md](SUPERVISOR-BUILD-PLAN.md). The concrete `v0.4` isolation plan lives in [SANDBOX-RUNNER-PLAN.md](SANDBOX-RUNNER-PLAN.md).

When the user chats with the supervisor in pipeline mode, the chat route now injects a live team snapshot: current phase, pipeline status, run goal, active turn, recent events, pending approvals, and recommended control actions. The UI also derives a proactive supervisor update from the same state so the user sees a manager-style summary without having to inspect raw logs, and the orchestrator now emits supervisor-language chat updates at key transitions like planning start, review handoff, approval waits, pauses, resumes, and completion. Before a run exists, the supervisor captures the concept locally and waits for an explicit start command instead of freelancing. That makes the supervisor much closer to a real team manager instead of a generic diagnostic assistant.

## The Flow

### Phase 0: Concept

1. The **user** sends the first message to the **Supervisor** — this captures the concept.
2. After the concept is captured, the **Supervisor** engages naturally via Claude — discussing the idea, giving opinions, asking clarifying questions, and suggesting improvements. The user can also talk to the **Planner** directly.
3. Chat happens in a staging area (`~/Builds/.staging/`). No project directory created yet.
4. When the user asks the **Supervisor** to start, or uses the fallback **START** button, staging moves to a real project dir and the pipeline runs according to the dashboard toggles (security mode, permission mode, run goal). The concept-phase conversation is preserved in the pipeline events.

This same pattern also works for existing repos: tell the Supervisor it is an existing codebase, describe the changes you want, and let the Planner build context from the real repo before the team starts planning or coding.

### Phase 1: Planning

5. The **Planner** reads `build-plan-template.md` — the planning playbook.
6. The **Planner** completes the planning checklist — research, write, verify, context, one self-review pass.
7. The **Planner** writes the plan to `plan.md` with complete, copy-pasteable code for every file.
8. The **Planner** self-reviews once, then hands the plan to the **Plan Reviewer**. The reviewer is the formal external review gate.

For larger builds, this phase can legitimately take 10-15 minutes or longer because the planner is verifying packages, docs, and architecture details before the team starts coding.

### Phase 1b: Plan Review

9. The **Plan Reviewer** reads the plan and sends structured questions back to the **Planner**.
10. The **Planner** answers with verified information and updates the plan.
11. This loops until the **Plan Reviewer** is fully satisfied. No round limit.
12. The **Plan Reviewer** approves. The plan is locked — no agent can modify it from this point.
13. If the supervisor selected **Plan Only** or armed **Stop After Review**, the pipeline pauses here and waits for an explicit continue command.

### Phase 2: Coding

14. The **Coder** reads the locked plan and builds exactly what it says.
15. No improvising, no interpreting, no "improving."

### Phase 3: Code Review

16. The **Tester** reads the plan and the code. Checks: does the code match the plan?
17. If the **Tester** has issues, sends them to the **Coder**. The coder fixes and sends back.
18. Loops until the **Tester** is satisfied with the code.

### Phase 4: Testing

19. The **Tester** runs the code and tests it.
20. If tests fail, the **Tester** sends failures to the **Coder**. The coder fixes and the tester tests again.
21. Loops until all tests pass.

### Phase 5: Deploy

22. Build complete. Project is in `~/Builds/<project-name>/`.

## Enforcement: Scripts, Not Prompts

LLMs ignore prompt instructions. An agent told "only write plan.md" will write code files. An agent told "don't modify anything" will edit the plan.

Restrictions are enforced by a `PreToolUse` hook (`pipeline/.claude/hooks/approval-gate.sh`) that prevents agents from accidentally exceeding their role. The hook is a guardrail, not a sandbox — see [SECURITY.md](SECURITY.md) for the threat model, known limitations, and a matrix of what is fixable in-hook vs what requires design changes or OS-level isolation. The hook reads the `PIPELINE_AGENT` environment variable and gates every tool call:

| Team Member | Write | Bash | Agent Tool |
|-------------|-------|------|------------|
| **Planner (`A`)** | `plan.md` only in the current project | Blocked | Blocked |
| **Plan Reviewer (`B`)** | Blocked | Blocked | Blocked |
| **Coder (`C`)** | Current project only (except plan.md) | Safe=auto, dangerous=approval | Blocked |
| **Tester (`D`)** | Blocked | Safe=auto, dangerous=approval | Blocked |
| **Supervisor (`S`)** | `~/Builds/` only (no `.claude/`) | Yes (restricted) | Blocked |

Additional protections:
- `Write`/`Edit`/`NotebookEdit` are jailed to the active project for the planner/coder and blocked for the reviewer/tester
- Pipeline sessions set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, so Bash `cd` does not persist into later file-edit tool calls
- Plan is locked after the plan reviewer approves
- Agent tool blocked for all agents (prevents recursive spawning)
- Strict mode requires approval for every Bash call from the coder and tester
- `--permission-mode auto` adds Claude's AI safety classifier on top (configurable via dashboard toggle or `PIPELINE_PERMISSION_MODE` env var)

Roadmap:
- **Fast mode** is the current autonomous default
- **Strict mode** is available for pipeline runs
- **Isolated mode** will run agents inside per-project sandboxes
- **Request-scoped approvals** are now implemented for strict-mode Bash approvals
- The concrete implementation plan lives in [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md)

## Agent Communication

Agents don't parse free text. They communicate via structured JSON schemas:

```json
// B reviewing A's plan
{ "status": "approved" }
{ "status": "questions", "questions": ["What about error handling?"] }

// D reviewing C's code
{ "status": "approved" }
{ "status": "issues", "issues": ["Missing input validation on POST /users"] }

// D testing C's code
{ "status": "passed" }
{ "status": "failed", "failures": ["PUT /users returns 500 on empty body"] }
```

The orchestrator routes these signals and uses `isPositiveSignal()` to normalize approval variants.

## Session Spawning

Each agent runs as a separate Claude Code session:

```bash
claude -p "<prompt>" \
  --system-prompt-file <role-file> \
  --permission-mode auto \
  --model claude-opus-4-6 \
  --output-format stream-json \
  --verbose
```

- `--permission-mode auto` — Claude's AI classifier handles general safety (default; override with `PIPELINE_PERMISSION_MODE` env var or the dashboard Permission Mode toggle)
- `--output-format stream-json` — real-time streaming for the viewer
- `PIPELINE_AGENT` env var — tells the hook which agent is running
- `PIPELINE_PERMISSION_MODE` env var — `auto` (default), `plan`, or `dangerously-skip-permissions`
- Role files and shared doctrine provide the team model; hooks provide the lighter safety/discipline guardrails around it
- Session ids are now persisted mid-turn so stalled A/B runs can be recovered instead of always forcing a reset
- Stall detection: 5-minute idle timeout, up to 3 auto-resume attempts (A, B, and D), bash-aware (long-running commands don't trigger false stalls)
- Future hardening replaces direct host spawning with a sandbox runner; see [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md) and [SANDBOX-RUNNER-PLAN.md](SANDBOX-RUNNER-PLAN.md)

## The Orchestrator

`pipeline/orchestrator.ts` is deterministic code, not an LLM. It:

1. Spawns agent sessions in order
2. Parses their streaming JSON output
3. Routes structured signals between agents
4. Advances the pipeline phase on approval signals
5. Tracks token usage, costs, and events
6. Persists active-turn runtime state and recoverable session ids
7. Can pause cleanly after approved plan review when the supervisor requests it
8. Can continue from an approved plan or manually resume a stalled A/B planning-review turn
9. Writes everything to `pipeline-events.json` for the viewer

The orchestrator cannot be confused, distracted, or convinced to skip steps.

## The Viewer

A Next.js app that polls `pipeline-events.json` every 400ms and renders two interfaces for the same team runtime:

### Office View

- Pixel art office scene with 5 agents at desks
- Live feed of all events
- Proactive supervisor update card driven by live run state
- 5-panel grid (S + A/B/C/D) with per-agent event streams
- Current-turn and stalled-turn visibility for recovery
- Supervisor controls for `plan-only`, `stop after review`, `continue build`, and `resume stalled run`
- Dashboard with phase progress, token usage, cost
- Per-panel chat inputs for direct agent communication
- START/STOP/Reset controls

### Squad View

- Supervisor-first chat workspace without the office UI
- Direct specialist tabs for Planner / Reviewer / Coder / Tester
- The same supervisor summaries, execution-path status, approvals, and fallback controls
- The same pipeline/manual team state underneath

API routes handle:
- `POST /api/chat` — spawns a claude session for direct chat (Phase 0 or post-build)
- `POST /api/start-pipeline` — creates project dir from staging, spawns orchestrator
- `POST /api/pipeline-control` — arms or clears supervisor stop-after-review
- `POST /api/resume-pipeline` — continues from an approved plan or resumes a stalled planning/review turn
- `POST /api/stop-pipeline` — kills orchestrator + claude sessions
- `POST /api/reset` — clears staging, resets stuck projects
- `GET /api/state` — returns current pipeline state
- `POST /api/approve` — approves/denies dangerous bash commands

## Data Flow

```
User types in viewer
  -> POST /api/chat -> spawns claude session -> writes to .staging/pipeline-events.json
  -> GET /api/state polls .staging/ -> viewer renders events

User hits START
  -> POST /api/start-pipeline
  -> staging moves to ~/Builds/<project>/
  -> orchestrator spawns as detached process
  -> orchestrator writes to ~/Builds/<project>/pipeline-events.json
  -> GET /api/state polls project dir -> viewer renders events

User hits STOP
  -> POST /api/stop-pipeline -> pkill orchestrator + claude sessions

User hits RESET
  -> POST /api/reset -> clears staging, resets active projects
```

## Communication Map

```
     ┌─────┐
     │ YOU │  gives concept, answers A's questions (Phase 0 only)
     └──┬──┘
        │
        ┌─────┐
        │  B  │  plan reviewer — only talks to A
        └──┬──┘
           │
     ┌─────┴─────┐
     │     A     │  planner / final handoff — talks to everyone
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │     C     │  coder — talks to A (questions) and D (code)
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │     D     │  reviewer + tester — talks to C (fixes) and A (final)
     └───────────┘

     S sits above — supervisor / recovery partner for the team

     After Phase 0, pipeline runs autonomous by default
     Strict mode can still surface approval prompts for C/D Bash
     All sessions: claude --permission-mode auto --model claude-opus-4-6
```

## Manual Mode

In manual mode, the orchestrator does not exist. The user is the orchestrator.

- **No pipeline, no phases, no automation.** 5 Claude sessions with one-line expertise labels.
- **Claude permission prompts still apply.** Manual mode is looser than pipeline mode, but it is not unguarded.
- **State lives in `~/Builds/.manual/manual-state.json`** — separate from pipeline state.
- **No role files.** Agents get a one-line system prompt on first message:
  - A: "You specialize in software planning and architecture."
  - B: "You specialize in code review and finding gaps."
  - C: "You specialize in writing code."
  - D: "You specialize in testing and debugging."
  - S: "You help oversee and diagnose issues."
- **No `PIPELINE_AGENT` env var** — hooks don't apply pipeline restrictions.
- **Model picker** — user chooses Opus or Sonnet per session.
- **Handoff button** — grabs an agent's last text response and stages it as context for the next agent messaged. Max 2000 chars.
- **Per-agent sending** — multiple agents can be active simultaneously.
- **Session resume** — sessions persist in `manual-state.json` and resume via `--resume`.

```
Manual Mode Data Flow

User types in any panel
  -> POST /api/chat { mode: 'manual', model, agent, message }
  -> spawns claude with --system-prompt (first msg) or --resume (subsequent)
  -> cwd: ~/Builds/.manual/
  -> streams events into manual-state.json
  -> GET /api/state?mode=manual polls manual-state.json -> viewer renders

User hits RESET
  -> POST /api/reset { mode: 'manual' } -> deletes ~/Builds/.manual/
```
