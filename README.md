<p align="center">
  <h1 align="center">The Dev Squad</h1>
  <p align="center"><strong>Give Claude its own dev team.</strong></p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.1-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/claude-opus%204.6-blueviolet" alt="Claude Opus 4.6" />
  <img src="https://img.shields.io/badge/agents-5-orange" alt="5 Agents" />
  <img src="https://img.shields.io/badge/node-22%2B-339933" alt="Node 22+" />
</p>

<p align="center">
  <img src="demo.gif" alt="The Dev Squad Demo" width="800" />
</p>

---

> Give Claude a dev team in one workspace: one supervisor, four specialists, and a shared build doctrine that produces bulletproof plans before coding starts.
>
> The point is not just that it runs on your Claude subscription. The point is that you stop copy-pasting between sessions, keep context in one place, and let a supervisor manage the team for you while you can still jump in and talk to any specialist directly.

---

## Why This Exists

I was spending hours doing the same ritual over and over: open one Claude session to shape the idea, another to write the plan, another to review it, another to code it, another to test it. Every handoff meant more copy-paste, more context loss, and more chances for the build to drift.

The Dev Squad is the answer to that problem. Instead of juggling separate chats by hand, you give Claude its own dev team in one place. A supervisor (`S`) can manage the flow for you. The planner writes the build plan. The reviewer challenges it. The coder implements it. The tester checks it. You can still intervene directly with any of them whenever you want, but you no longer have to manually orchestrate the whole thing.

The real win is not “multi-agent” by itself. The real win is that the build plan becomes the contract for the whole team. A writes a plan with complete, copy-pasteable code. B tears it apart until there are no gaps. Only then does C touch the implementation. D checks the result against the approved plan instead of guessing what “done” means.

The key insight is still the same: **the plan is the code contract**. Agent A does not write a vague spec sheet. A writes a plan that is complete enough for the coder to build without asking a single question. That is what makes the builds reliable — by the time coding starts, the biggest decisions should already be made and verified.

That is why the team shares a doctrine: `build-plan-template.md`, `checklist.md`, and the locked `plan.md`. The supervisor can run the team for you, but the quality bar stays the same. Research first. Verify from source. Write complete code in the plan. Do one self-review. Let B challenge it. Only then move to C and D.

This project exists because I wanted that whole process in one interface, with one shared context, and a supervisor who can run it for me when I do not want to babysit five different sessions.

It also happens to run on a Claude subscription instead of the API, which is nice. But that is a secondary benefit. The main thing is: Claude has a dev team now.

---

## What This Is

The Dev Squad is a supervisor-led Claude dev team:

- `S` is the human-facing supervisor
- `A`, `B`, `C`, and `D` are the specialists
- the whole team follows the same doctrine: `build-plan-template.md`, `checklist.md`, and the approved `plan.md`
- you can talk to `S` by default or jump directly into any specialist chat whenever you want

Today, the current product shape is already visible:

- S can capture the concept, start the team, pause after review, continue an approved plan, resume stalled planning/review turns, and stop the run
- the specialists keep their own context in the same workspace instead of forcing you to copy/paste between sessions
- the dashboard and office UI let you watch everything happen in one place

The longer-term implementation plan for pushing even more authority into `S` lives in [SUPERVISOR-BUILD-PLAN.md](SUPERVISOR-BUILD-PLAN.md).

---

## The Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| **A** | Planner | Chats with you about the concept, researches everything, writes a build plan with complete code for every file |
| **B** | Reviewer | Reads A's plan and tears it apart. Asks hard questions. Loops with A until there are zero gaps. |
| **C** | Coder | Follows the approved plan exactly. Writes every file, installs deps, builds the project. No improvising. |
| **D** | Tester | Reviews C's code against the plan, runs it, catches bugs. Loops with C until everything passes. |
| **S** | Supervisor | Your supervisor and recovery partner. Today S helps inspect runs, explain what the team is doing, and diagnose stalls or loops. |

Each agent is a separate Claude Code session running Claude Opus 4.6. They communicate through structured JSON signals routed by an orchestrator. Restrictions are enforced by a `PreToolUse` hook, but the real product idea is not “a hook-driven pipeline.” It is the team structure plus the shared doctrine: the build plan template, the checklist, and the locked plan. See [SECURITY.md](SECURITY.md) for the threat model and known limitations.

## How It Works

```
1. Open the viewer
2. Tell S what you want to build
3. Ask S to start planning or start the build
4. Let S manage the team, or jump into any specialist panel yourself
5. Your project is in ~/Builds/
```

S is the recommended front door now. The old buttons and direct specialist chats are still there, but the product is increasingly shaped around “talk to the supervisor, let the supervisor use the team.”

**Phase 0: Concept** — You talk to S or A. The recommended flow is to tell S what you want, let S capture the concept, and then tell S when to start the team. Strict mode can still ask for Bash approvals later.

**Phase 1: Planning** — A reads the build plan template and checklist, researches the concept (web searches, docs, source code), writes `plan.md` with complete, copy-pasteable code for every file, then does one self-review pass before handing it to B. No placeholders.

**Phase 1b: Plan Review** — B reads the plan and sends structured questions back to A. They loop until B is fully satisfied and approves. The plan is locked. No agent can modify it.

**Phase 2: Coding** — C reads the locked plan and builds exactly what it says. Every file, every dependency, every line of code.

**Phase 3: Code Review + Testing** — D reads the plan and the code. Checks every item. If anything doesn't match or fails, D sends issues back to C. They loop until D approves and all tests pass.

**Phase 4: Deploy** — The finished project is ready.

The plan-review loop between A and B catches design gaps before a single line of code is written. The test loop between C and D catches implementation bugs before anything ships. Each loop has no round limit — they keep going until it's right.

---

## The Viewer

A pixel art office where 5 agents sit at desks. You watch them work in real-time:

- **Live Feed** — Every event from every agent, timestamped and color-coded
- **Dashboard** — Phase progress, elapsed time, file count, errors
- **Current Turn** — Shows which agent turn is active, what it is doing, and whether it looks stalled
- **5-Panel Grid** — S (supervisor) panel on the left, A/B/C/D on the right. Each panel shows that agent's activity with auto-scroll. Click any panel to expand.
- **Per-Panel Chat** — Each panel has its own input. Talk directly to any agent.
- **Controls** — `Full Build` / `Plan Only`, `START`, `STOP AFTER REVIEW`, `CONTINUE BUILD`, `RESUME STALLED RUN`, `STOP`, `Reset`, `View Plan`. These now act as fallback controls; you can also ask S to do the same things in chat.
- **Art style** — The office scene uses a mix of original pixel sprites and CSS-drawn props

When idle, agents wander the office, visit the hookah lounge, and play ping pong.

---

## Requirements

- **Claude Code CLI** — this is the engine. You must have the `claude` command installed and working in your terminal. Install it from [claude.ai/code](https://claude.ai/code).
- **Active Claude subscription** — Max, Pro, or Team. All 5 agent sessions run on your subscription. No API key needed.
- **Node.js 22+**
- **pnpm**

## Installation

```bash
git clone https://github.com/johnkf5-ops/the-dev-squad.git
cd the-dev-squad
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

That's it. The viewer handles everything — spawning agents, running the orchestrator, managing builds.

---

## Two Modes

The Dev Squad has two modes, toggled in the dashboard:

### Pipeline Mode (default)

The autonomous build pipeline. You describe what you want, and 5 agents build it with minimal involvement from you. In strict mode, the UI can still ask you to approve C/D Bash commands.

1. **Reset if Needed** — Clear any previous session.
2. **Talk to S or A** — The preferred path is to tell S what you want and let S manage the team. Direct A chat still works when you want to hash out the concept yourself.
3. **Choose a Goal** — Pick **Full Build** to run the whole team or **Plan Only** to stop cleanly after B approves the plan. The selected goal also acts as the default when you ask S to start from chat.
4. **Start from Chat or Button** — Tell S to start planning or start the build. The old **START** button still works as a fallback control.
5. **Pause from Chat or Button** — During planning or plan review, ask S to stop after review, or click **STOP AFTER REVIEW** if you want the run to pause after B approves the plan instead of continuing into coding.
6. **Watch** — Each panel auto-scrolls as events come in. Click any panel to expand. The dashboard shows phase progress.
7. **Continue or Recover** — If the run pauses after plan review, ask S to continue the build or use **CONTINUE BUILD**. If A or B stalls during planning/review, ask S to resume the stalled run or use **RESUME STALLED RUN**.
8. **Stop** — Ask S to stop the run, or click **STOP** at any time.
9. **View Plan** — Once A writes the plan, click **View Plan** to read it.
10. **Done** — Your project is in `~/Builds/<project-name>/`.

After the build, chat with any agent for post-build work — fixing bugs, adding features, asking questions.

### Strict Mode

Strict mode is for users who want a human in the loop for shell execution from the build agents.

- **What changes** — Every Bash call from agents C and D pauses for approval
- **What you see** — The dashboard shows an approval card with the agent, phase, and command description
- **What happens on approve** — The exact approved command gets a one-time grant and runs once
- **What happens on deny** — The agent is told the command was denied and must continue without it or explain what is blocked
- **What does not change** — Strict mode improves practical safety, but it is not OS-level sandboxing. The known hook limitations in [SECURITY.md](SECURITY.md) still apply.
- **What this is not** — Strict mode does not change the team model. It just adds human approval on risky shell execution.

### Manual Mode

You are the orchestrator. 5 panels, 5 Claude sessions, each with a specialty. You talk to whoever you want, whenever you want. No automation, no phases, no pipeline.

- **No START/STOP** — there's no pipeline to run. You direct everything.
- **Model picker** — Choose between Opus and Sonnet. Appears only in manual mode.
- **Hand off →** — Each panel has a handoff button. Click it to grab that agent's last response and stage it as context for the next agent you message. One click to pass work between agents.
- **Per-agent chat** — Each panel has its own send button. You can talk to multiple agents at once — they run independently.
- **No role files** — Agents don't follow pipeline templates or checklists. They're just Claude sessions with expertise labels (planning, code review, coding, testing, diagnostics). You decide what they do.

Manual mode is useful when you want the multi-panel workspace without the automation — prototyping, brainstorming, or running your own workflow.

## The UI

The screen is split into two sections:

**Top half** — A pixel art office with 5 agents at desks. They animate in real-time as they work. Below the office is a live feed showing every event from every agent. To the right is a dashboard with the mode toggle, agent status, and controls.

**Bottom half** — A 5-panel grid. The **S (Supervisor)** panel spans the left column. The **A, B, C, D** panels fill the right in a 2x2 grid. Each panel shows that agent's activity and has its own chat input at the bottom.

### After the Build (Pipeline Mode)

Once the build is complete, you can chat directly with any agent for post-build work. Click on C's panel and ask it to fix a bug. Click on D's panel and ask it to run more tests. Each agent retains context from the build.

### The Supervisor (S Panel)

The S panel on the left is the beginning of the "Claude with a dev team" model. Before a run starts, S now captures the concept locally and waits for an explicit start command instead of freelancing. Once a run exists, S gets a live team snapshot every time you chat with it: current phase, pipeline status, active turn, recent events, pending approvals, and recommended next actions. S can also trigger the core supervisor controls directly from chat: start a run, start plan-only mode, stop after review, continue an approved plan, resume a stalled planning/review turn, or stop the run. If something breaks, stalls, loops, or looks suspicious, ask S what is happening or tell S what you want the team to do next.

### Controls Reference

| Control | Mode | What It Does |
|---------|------|-------------|
| **PIPELINE / MANUAL** | Both | Toggle between autonomous pipeline and manual orchestration |
| **Model Picker** | Manual | Choose Claude model (Opus or Sonnet) |
| **Full Build / Plan Only** | Pipeline | Chooses whether the supervisor should run the whole team or stop after approved plan review |
| **START** | Pipeline | Fallback button that creates the project directory, spawns the orchestrator, and begins the selected supervisor goal |
| **STOP AFTER REVIEW** | Pipeline | Arms a clean pause once B approves the plan |
| **KEEP RUNNING AFTER REVIEW** | Pipeline | Clears the stop-after-review request and lets the run continue into coding |
| **CONTINUE BUILD** | Pipeline | Resumes a paused plan-only / stopped-after-review run from the approved plan |
| **RESUME STALLED RUN** | Pipeline | Re-launches the orchestrator and resumes a stalled A/B planning-review turn from the saved Claude session |
| **STOP** | Pipeline | Kills orchestrator and all agent sessions immediately |
| **Reset** | Both | Clears all state. In pipeline mode, also stops the orchestrator. |
| **View Plan** | Pipeline | Opens `plan.md` in a modal (appears after A writes the plan) |
| **Hand off →** | Manual | Stages the agent's last response as context for the next agent you message |

---

## Security

Agents are constrained by a `PreToolUse` hook that gates every tool call. The hook prevents accidental lane drift — it is not a security sandbox. See [SECURITY.md](SECURITY.md) for the threat model, known limitations, and a matrix showing what is fixable in-hook vs what requires design changes or OS-level isolation.

This project is meant to provide practical guardrails and a disciplined workflow, not a security sandbox. If you plan to use it on sensitive code or systems, read [SECURITY.md](SECURITY.md) first and decide whether the current threat model fits your environment.

| Agent | Can Write | Can Run Bash | Can Spawn Agents |
|-------|-----------|-------------|-----------------|
| A (Planner) | `plan.md` only in the current project | No | No |
| B (Reviewer) | Nothing | No | No |
| C (Coder) | Current project only (except `plan.md`) | Yes (dangerous cmds need approval) | No |
| D (Tester) | Nothing | Yes (dangerous cmds need approval) | No |
| S (Supervisor) | `~/Builds/` only (no `.claude/`) | Yes (pattern-restricted) | No |

Additional protections:
- `Write`/`Edit`/`NotebookEdit` are jailed to the current project for A/C and blocked for B/D
- Pipeline sessions set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, so Bash `cd` does not persist into later file-edit tool calls
- Plan is locked after B approves — no agent can modify it
- A and B can use `WebSearch` and `WebFetch` for direct-source research and review
- Fast mode auto-approves safer Bash and asks for riskier Bash
- Strict mode requires approval for every Bash call from agents C and D
- All sessions use `--permission-mode auto` for Claude's built-in safety classifier

Roadmap:
- **Fast mode** stays the default for autonomy
- **Strict mode** is now available for pipeline runs
- **Isolated mode** will move agents into per-project sandboxes for stronger containment
- **Request-scoped approvals** are live; strict-mode approvals are now tied to explicit request records instead of "latest project wins"
- The concrete implementation plan lives in [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md)

---

## How Agents Communicate

Agents communicate via structured JSON — no text parsing:

```json
// B reviewing A's plan
{ "status": "approved" }
{ "status": "questions", "questions": ["What about error handling?"] }

// D reviewing C's code
{ "status": "approved" }
{ "status": "issues", "issues": ["Missing input validation"] }

// D testing
{ "status": "passed" }
{ "status": "failed", "failures": ["PUT /users returns 500"] }
```

The orchestrator routes these signals between agents and advances the pipeline when an approval is received.

---

## Validation

Useful local checks:

- `pnpm test:hook` — verifies the agent/tool contract against the live approval hook
- `pnpm test:signals` — verifies structured signal parsing for plan review, code review, and test results
- `pnpm dev` — runs the viewer locally at [http://localhost:3000](http://localhost:3000)

---

## Project Structure

```
the-dev-squad/
  src/
    app/
      page.tsx                      # Main page — dashboard, panels, controls
      api/                          # API routes (chat, start, stop, reset, state)
    components/
      mission/                      # Pixel art office scene
    lib/
      use-pipeline.ts               # React hook — polls state, exposes actions
  pipeline/
    orchestrator.ts                 # Spawns agents, routes signals, enforces flow
    .claude/hooks/approval-gate.sh  # Per-agent permission enforcement
    role-a.md, role-b.md, etc.      # Agent role context files
    build-plan-template.md          # Template A follows when writing plans
  public/
    sprites/                        # Character and furniture sprites
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Contributors

- CrashOverride LLC — creator and maintainer
- Claude Code — core implementation and pipeline iteration partner
- OpenAI Codex — contributor for security review, hardening guidance, and documentation updates

## License

MIT - see [LICENSE](LICENSE) for details.

This project is provided `AS IS`, without warranty. It is your responsibility to review approvals, review generated code, and decide whether this tool is appropriate for your environment. The MIT license is the controlling legal text, and [SECURITY.md](SECURITY.md) documents the current threat model and limitations.

Copyright (c) 2026 CrashOverride LLC

---

<p align="center">
  <strong>Built with Claude Code and OpenAI Codex. Runs on Claude Code. No API required.</strong>
</p>
