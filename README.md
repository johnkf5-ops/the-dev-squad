<p align="center">
  <h1 align="center">The Dev Squad</h1>
  <p align="center"><strong>5 Claude Code sessions that talk to each other to build software.</strong></p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/claude-opus%204.6-blueviolet" alt="Claude Opus 4.6" />
  <img src="https://img.shields.io/badge/agents-5-orange" alt="5 Agents" />
  <img src="https://img.shields.io/badge/API%20cost-$0-brightgreen" alt="Zero API Cost" />
  <img src="https://img.shields.io/badge/node-22%2B-339933" alt="Node 22+" />
</p>

<p align="center">
  <img src="demo.gif" alt="The Dev Squad Demo" width="800" />
</p>

---

> One plans. One reviews. One codes. One tests. One supervises. They communicate through structured signals, review each other's work, and loop until every step is right. The result is bulletproof plans that produce bulletproof builds.
>
> No API keys. No per-token costs. All 5 sessions run on your Claude subscription.

---

## Why This Exists

I was spending hours writing build plans. Not specs — full plans with complete, copy-pasteable code for every file. I found that if the plan was bulletproof, the build was bulletproof. No guessing, no improvising, no "I'll figure it out during implementation." The coder just follows the plan.

But writing those plans was brutal. I'd go back and forth with Claude — "is this thorough enough?", "did you verify this package exists?", "what about error handling?" — until the session would lose context. I'd open a new session, paste the plan, keep going. Then I'd open another session for the reviewer, another for the coder, another for testing. I was manually orchestrating 4-5 Claude sessions, copying messages between them.

The Dev Squad is what happens when you automate that. The planner writes the plan with complete code — not descriptions, not pseudocode, actual code. The reviewer tears it apart and loops with the planner until there are zero gaps. Only then does the coder touch it. The coder doesn't think — it follows the plan exactly. The tester doesn't guess — it checks every item against the plan.

The key insight: **the plan IS the code**. Agent A doesn't write a spec sheet. A writes a plan that contains every line of code the coder will need. The reviewer's job is to make sure that plan is so complete that the coder never has to ask a single question. That's what makes the builds bulletproof — by the time C starts coding, every decision has already been made and verified.

I built a template and checklist that A follows — research, verify from source, write complete code, do one self-review pass, then hand off a review-ready plan. A can't skip steps. B can't approve until every question is answered. The pipeline enforces quality at every stage so I don't have to.

My rule: the plan must be 100% bulletproof with zero errors and evidence to verify every decision before I move forward with a build. No "this should work." No "I think this package exists." Every claim is verified from source. Every code block is complete and tested in the planner's head before the coder ever sees it.

The result: builds come out with no errors. I used to spend hours after a build going back and fixing things — missing dependencies, wrong API signatures, broken imports. Now, 99% of the time, the build produces exactly what I asked for. On the rare occasion something needs troubleshooting, every agent still has complete context because we didn't burn through the session going in circles. The planner remembers the concept. The coder remembers what it built. The tester remembers what it tested. Nobody lost context because each agent only did its one job.

This saves me hours every day.

---

## The Agents

| Agent | Role | What It Does |
|-------|------|-------------|
| **A** | Planner | Chats with you about the concept, researches everything, writes a build plan with complete code for every file |
| **B** | Reviewer | Reads A's plan and tears it apart. Asks hard questions. Loops with A until there are zero gaps. |
| **C** | Coder | Follows the approved plan exactly. Writes every file, installs deps, builds the project. No improvising. |
| **D** | Tester | Reviews C's code against the plan, runs it, catches bugs. Loops with C until everything passes. |
| **S** | Supervisor | Your diagnostic assistant. If something breaks or loops, S reads the event log and helps figure out what went wrong. |

Each agent is a separate Claude Code session running Claude Opus 4.6. They communicate through structured JSON signals routed by an orchestrator. Restrictions are enforced by a `PreToolUse` hook — a guardrail that prevents agents from accidentally drifting out of their lane. See [SECURITY.md](SECURITY.md) for the threat model and known limitations.

## How It Works

```
1. Open the viewer
2. Chat with Agent A — describe what you want to build
3. Hit START
4. Watch 5 agents build it autonomously by default
5. Your project is in ~/Builds/
```

**Phase 0: Concept** — You talk to Agent A. Describe what you want. A asks clarifying questions until the scope is clear. This is the only required human interaction in fast mode; strict mode can still ask for Bash approvals later.

**Phase 1: Planning** — A reads the build plan template, researches the concept (web searches, docs, source code), writes `plan.md` with complete, copy-pasteable code for every file, then does one self-review pass before handing it to B. No placeholders.

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
- **5-Panel Grid** — S (supervisor) panel on the left, A/B/C/D on the right. Each panel shows that agent's activity with auto-scroll. Click any panel to expand.
- **Per-Panel Chat** — Each panel has its own input. Talk directly to any agent.
- **Controls** — START, STOP, Reset, View Plan
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

1. **Reset** — Clear any previous session
2. **Talk to the Planner** — Type your concept in Agent A's panel. A asks clarifying questions until the scope is clear.
3. **Start the Pipeline** — Click **START**. The orchestrator runs A→B→C→D autonomously. A writes the plan, B reviews it, C codes it, D tests it.
4. **Watch** — Each panel auto-scrolls as events come in. Click any panel to expand. The dashboard shows phase progress.
5. **Stop** — Click **STOP** at any time to abort.
6. **View Plan** — Once A writes the plan, click **View Plan** to read it.
7. **Done** — Your project is in `~/Builds/<project-name>/`.

After the build, chat with any agent for post-build work — fixing bugs, adding features, asking questions.

### Strict Mode

Strict mode is for users who want a human in the loop for shell execution from the build agents.

- **What changes** — Every Bash call from agents C and D pauses for approval
- **What you see** — The dashboard shows an approval card with the agent, phase, and command description
- **What happens on approve** — The exact approved command gets a one-time grant and runs once
- **What happens on deny** — The agent is told the command was denied and must continue without it or explain what is blocked
- **What does not change** — Strict mode improves practical safety, but it is not OS-level sandboxing. The known hook limitations in [SECURITY.md](SECURITY.md) still apply.

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

The S panel on the left is **not** part of the pipeline. S is your diagnostic assistant. If something breaks, stalls, or loops, type in the S panel to ask what went wrong. S can read the event log, the plan, the code, and help you figure out the issue. You don't need to use S during a normal build — it's there when things go sideways.

### Controls Reference

| Control | Mode | What It Does |
|---------|------|-------------|
| **PIPELINE / MANUAL** | Both | Toggle between autonomous pipeline and manual orchestration |
| **Model Picker** | Manual | Choose Claude model (Opus or Sonnet) |
| **START** | Pipeline | Creates project directory, spawns orchestrator, begins autonomous build |
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
