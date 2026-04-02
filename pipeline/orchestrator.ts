#!/usr/bin/env npx tsx

/**
 * Pipeline Build Orchestrator (Streaming)
 *
 * Spawns Claude Code sessions and streams all activity to the viewer.
 * You see every tool call, file read/write, and agent response in real-time.
 *
 * Usage:
 *   npx tsx orchestrator.ts "Your build concept here"
 *
 * Viewer (separate terminal):
 *   npx tsx viewer.ts
 *
 * Then open http://localhost:3456
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import {
  clearApprovedBashGrant,
  clearPendingApproval,
  writeApprovedBashGrant,
  waitForPendingApproval,
  writePendingApproval,
  type ApprovedBashGrant,
  type PendingApproval,
} from '../src/lib/pipeline-approval.ts';
import { extractStructuredSignal } from '../src/lib/pipeline-signal.ts';
import {
  EMPTY_RUNTIME,
  MAX_AUTO_RESUMES,
  TURN_IDLE_TIMEOUT_MS,
  buildResumePrompt,
  canAutoResumeTurn,
  shouldMarkTurnStalled,
  summarizePrompt,
  type PipelineRuntimeState,
} from '../src/lib/pipeline-runtime.ts';

// ── Config ──────────────────────────────────────────────────────────

const BUILDUI_DIR = resolve(import.meta.dirname || __dirname);
const BUILDS_DIR = join(homedir(), 'Builds');

const ROLE_A = join(BUILDUI_DIR, 'role-a.md');
const ROLE_B = join(BUILDUI_DIR, 'role-b.md');
const ROLE_C = join(BUILDUI_DIR, 'role-c.md');
const ROLE_D = join(BUILDUI_DIR, 'role-d.md');

const MODEL = 'claude-opus-4-6';

// Effort levels per agent — quality gates (B, D) get max reasoning depth
const AGENT_EFFORT: Record<string, string> = {
  A: 'high',   // Planner — follows template, high is enough
  B: 'max',    // Reviewer — must find gaps, deep reasoning pays off
  C: 'high',   // Coder — executing approved plan
  D: 'max',    // Tester — must catch bugs, verify correctness
  S: 'high',   // Supervisor — not currently used
};

// ── CLI Args ────────────────────────────────────────────────────────
//
// Two modes:
//   Standalone:  npx tsx orchestrator.ts "Your build concept here"
//   From viewer: npx tsx orchestrator.ts --project-dir /path --a-session SESSION_ID
//

let concept = '';
let projectDir = '';
let existingASession = '';
let securityMode = process.env.PIPELINE_SECURITY_MODE === 'strict' ? 'strict' : 'fast';
let resumingExistingProject = false;

const args = process.argv.slice(2);
const projectDirIdx = args.indexOf('--project-dir');
const aSessionIdx = args.indexOf('--a-session');

if (projectDirIdx !== -1) {
  // Launched by viewer or resumed from existing project
  resumingExistingProject = true;
  projectDir = args[projectDirIdx + 1];
  if (aSessionIdx !== -1) existingASession = args[aSessionIdx + 1];
  // Read concept from existing state
  try {
    const existing = JSON.parse(readFileSync(join(projectDir, 'pipeline-events.json'), 'utf8'));
    concept = existing.concept || 'Build from viewer';
    if (!existingASession) existingASession = existing.sessions?.A || '';
    if (existing.securityMode === 'strict') securityMode = 'strict';
  } catch {
    concept = 'Build from viewer';
  }
} else {
  // Standalone mode
  concept = args.join(' ').trim();
  if (!concept) {
    console.error('Usage: npx tsx orchestrator.ts "Your build concept here"');
    console.error('   or: npx tsx orchestrator.ts --project-dir /path --a-session SESSION_ID');
    process.exit(1);
  }

  const projectName = concept
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  projectDir = join(BUILDS_DIR, projectName);
}

// ── Project Setup ───────────────────────────────────────────────────

mkdirSync(projectDir, { recursive: true });

if (!existsSync(join(projectDir, 'checklist.md'))) {
  copyFileSync(join(BUILDUI_DIR, 'checklist-template.md'), join(projectDir, 'checklist.md'));
}
if (!existsSync(join(projectDir, 'build-plan-template.md'))) {
  copyFileSync(join(BUILDUI_DIR, 'build-plan-template.md'), join(projectDir, 'build-plan-template.md'));
}

// Copy hooks into project so agents pick them up
mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
copyFileSync(
  join(BUILDUI_DIR, '.claude', 'settings.json'),
  join(projectDir, '.claude', 'settings.json')
);
copyFileSync(
  join(BUILDUI_DIR, '.claude', 'hooks', 'approval-gate.sh'),
  join(projectDir, '.claude', 'hooks', 'approval-gate.sh')
);
// Ensure executable
try { execFileSync('chmod', ['+x', join(projectDir, '.claude', 'hooks', 'approval-gate.sh')]); } catch {}

// Git init for the project
if (!existsSync(join(projectDir, '.git'))) {
  try {
    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'Initial project setup'], { cwd: projectDir });
  } catch {}
}

// ── Event System ────────────────────────────────────────────────────

interface PipelineEvent {
  time: string;
  agent: 'A' | 'B' | 'C' | 'D' | 'S' | 'system';
  phase: string;
  type: string;
  text: string;
  detail?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

interface PipelineState {
  concept: string;
  projectDir: string;
  currentPhase: string;
  securityMode: 'fast' | 'strict';
  runGoal: 'full-build' | 'plan-only';
  stopAfterPhase: 'none' | 'plan-review';
  pipelineStatus: 'idle' | 'running' | 'paused' | 'complete' | 'failed';
  resumeAction?: 'none' | 'continue-approved-plan' | 'resume-stalled-turn';
  activeAgent: string;
  agentStatus: Record<string, string>;
  sessions: Record<string, string>;
  buildComplete: boolean;
  usage: TokenUsage;
  runtime: PipelineRuntimeState;
  events: PipelineEvent[];
}

const eventsFile = join(projectDir, 'pipeline-events.json');

let state: PipelineState;
if (resumingExistingProject && existsSync(eventsFile)) {
  // Launched from viewer — load existing state (has Phase 0 events + sessions)
  const existing = JSON.parse(readFileSync(eventsFile, 'utf8'));
  state = {
    concept: existing.concept || concept,
    projectDir: existing.projectDir || projectDir,
    currentPhase: existing.currentPhase || 'concept',
    securityMode: existing.securityMode === 'strict' ? 'strict' : securityMode,
    runGoal: existing.runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    stopAfterPhase: existing.stopAfterPhase === 'plan-review' ? 'plan-review' : 'none',
    pipelineStatus: existing.pipelineStatus || (existing.buildComplete ? 'complete' : 'idle'),
    resumeAction: existing.resumeAction === 'continue-approved-plan' || existing.resumeAction === 'resume-stalled-turn' ? existing.resumeAction : 'none',
    activeAgent: existing.activeAgent || '',
    agentStatus: existing.agentStatus || { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: existing.sessions || {},
    buildComplete: !!existing.buildComplete,
    usage: existing.usage || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    runtime: existing.runtime || { ...EMPTY_RUNTIME },
    events: existing.events || [],
  };
} else {
  state = {
    concept,
    projectDir,
    currentPhase: 'concept',
    securityMode,
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    pipelineStatus: 'idle',
    resumeAction: 'none',
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    runtime: { ...EMPTY_RUNTIME },
    events: [],
  };
}

function flush() {
  writeFileSync(eventsFile, JSON.stringify(state, null, 2));
}

function emit(
  agent: PipelineEvent['agent'],
  phase: string,
  type: string,
  text: string,
  detail?: string
) {
  state.events.push({ time: new Date().toISOString(), agent, phase, type, text, detail });
  flush();

  // Terminal output with color
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const colors: Record<string, string> = {
    status: '\x1b[36m', send: '\x1b[33m', receive: '\x1b[33m',
    question: '\x1b[35m', answer: '\x1b[32m', issue: '\x1b[31m',
    fix: '\x1b[32m', approval: '\x1b[1m\x1b[32m', failure: '\x1b[31m',
    tool_call: '\x1b[90m', tool_result: '\x1b[90m', text: '\x1b[37m',
  };
  const c = colors[type] || '\x1b[0m';
  console.log(`${c}[${time}]   ${agent} | ${text}\x1b[0m`);
}

function emitSupervisor(phase: string, text: string) {
  emit('S', phase, 'text', text);
}

function setAgent(agent: string, status: string) {
  state.agentStatus[agent] = status;
  if (status === 'active') state.activeAgent = agent;
  flush();
}

function setPhase(phase: string) {
  state.currentPhase = phase;
  flush();
}

function setPipelineStatus(status: PipelineState['pipelineStatus']) {
  state.pipelineStatus = status;
  flush();
}

function saveSession(agent: string, sessionId: string) {
  state.sessions[agent] = sessionId;
  if (state.runtime.activeTurn?.agent === agent) {
    state.runtime.activeTurn.sessionId = sessionId;
  }
  flush();
}

function shouldStopAfterPlanReview() {
  return state.stopAfterPhase === 'plan-review' || state.runGoal === 'plan-only';
}

function startActiveTurn(agent: AgentId, prompt: string, autoResumeCount: number, resume?: string) {
  const now = new Date().toISOString();
  state.runtime.activeTurn = {
    agent,
    phase: state.currentPhase,
    status: 'running',
    startedAt: now,
    lastEventAt: now,
    sessionId: resume || state.sessions[agent] || '',
    promptSummary: summarizePrompt(prompt),
    autoResumeCount,
  };
  flush();
}

function noteActiveTurnActivity(agent: AgentId) {
  const activeTurn = state.runtime.activeTurn;
  if (!activeTurn || activeTurn.agent !== agent) return;

  activeTurn.lastEventAt = new Date().toISOString();
  if (activeTurn.status === 'stalled') {
    activeTurn.status = 'running';
    delete activeTurn.stalledAt;
    delete activeTurn.stallReason;
  }
  flush();
}

function markActiveTurnStalled(agent: AgentId, reason: string) {
  const activeTurn = state.runtime.activeTurn;
  if (!activeTurn || activeTurn.agent !== agent || activeTurn.status === 'stalled') return;

  activeTurn.status = 'stalled';
  activeTurn.stalledAt = new Date().toISOString();
  activeTurn.stallReason = reason;
  flush();
}

function clearActiveTurn(agent: AgentId) {
  if (state.runtime.activeTurn?.agent !== agent) return;
  state.runtime.activeTurn = null;
  flush();
}

// ── Tool Permissions ─────────────────────────────────────────────────
//
// Auto mode handles general safety (no mass deletions, no malicious code).
// Our PreToolUse hook handles pipeline-specific rules:
//   - S (Supervisor): unrestricted
//   - A: can only write plan.md, no writes during Phase 0
//   - B: can't write anything
//   - C: can write in ~/Builds/ except plan.md
//   - D: can't write anything
//   - Nobody writes outside ~/Builds/
//   - Agent tool blocked for A/B/C/D
//

type AgentId = 'A' | 'B' | 'C' | 'D';

// ── Streaming Claude Runner ─────────────────────────────────────────

function buildApprovalDescription(toolInput: Record<string, unknown>): string {
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
  if (command) return command;
  return JSON.stringify(toolInput);
}

async function runClaudeTurn(
  agent: AgentId,
  prompt: string,
  opts: {
    role: string;
    resume?: string;
    jsonSchema?: Record<string, unknown>;
    autoResumeCount?: number;
  }
): Promise<{
  result: string;
  sessionId: string;
  structured: Record<string, unknown> | null;
  permissionDenied: { toolName: string; toolInput: Record<string, unknown> } | null;
  interruptedForApproval: boolean;
  stalled: boolean;
}> {
  return new Promise((resolve, reject) => {
    const safePrompt = prompt.startsWith('-') ? 'User says: ' + prompt : prompt;
    const effort = AGENT_EFFORT[agent] || 'high';
    const args: string[] = [
      '-p', safePrompt,
      '--system-prompt-file', opts.role,
      '--permission-mode', 'auto',
      '--model', MODEL,
      '--effort', effort,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));

    const child = spawn('claude', args, {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PIPELINE_AGENT: agent,
        PIPELINE_SECURITY_MODE: state.securityMode,
        // Reset Claude's working directory after each Bash command so a `cd`
        // does not persist into later Write/Edit tool calls.
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      },
    });

    startActiveTurn(agent, safePrompt, opts.autoResumeCount || 0, opts.resume);

    let lastResult: Record<string, unknown> | null = null;
    let currentSessionId = opts.resume || '';
    let structured: Record<string, unknown> | null = null;
    const toolNames = new Map<string, string>();
    const toolInputs = new Map<string, Record<string, unknown>>();
    let permissionDenied: { toolName: string; toolInput: Record<string, unknown> } | null = null;
    let interruptedForApproval = false;
    let stalled = false;
    let settled = false;
    let lastStreamActivityAt = Date.now();

    const rl = createInterface({ input: child.stdout });
    const stallWatcher = setInterval(() => {
      if (settled) return;
      if (!shouldMarkTurnStalled(lastStreamActivityAt, Date.now(), TURN_IDLE_TIMEOUT_MS)) return;

      const canAutoResume = canAutoResumeTurn(agent, state.currentPhase) && !!currentSessionId;
      const reason = canAutoResume
        ? `Agent ${agent} appears stalled. Preserving the session for resume.`
        : `Agent ${agent} appears stalled. Manual intervention may be needed.`;

      markActiveTurnStalled(agent, reason);
      emit('system', state.currentPhase, 'status', reason);

      if (!canAutoResume) {
        clearInterval(stallWatcher);
        return;
      }

      stalled = true;
      settled = true;
      clearInterval(stallWatcher);
      resolve({
        result: '',
        sessionId: currentSessionId,
        structured,
        permissionDenied,
        interruptedForApproval,
        stalled,
      });
      child.kill('SIGTERM');
    }, 5_000);

    rl.on('line', (line) => {
      if (!line.trim()) return;
      lastStreamActivityAt = Date.now();
      noteActiveTurnActivity(agent);

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const type = event.type as string;

      if (type === 'system') {
        currentSessionId = (event.session_id as string) || currentSessionId;
        if (currentSessionId) saveSession(agent, currentSessionId);
      } else if (type === 'assistant') {
        const msg = event.message as Record<string, unknown>;
        const content = msg?.content as Array<Record<string, unknown>>;
        if (!content) return;

        for (const block of content) {
          if (block.type === 'tool_use') {
            const toolName = block.name as string;
            const input = block.input as Record<string, unknown>;
            const toolUseId = block.id as string;
            if (toolUseId) {
              toolNames.set(toolUseId, toolName);
              toolInputs.set(toolUseId, input);
            }

            let desc = toolName;
            let detail = '';

            if (toolName === 'Read' && input.file_path) {
              desc = `READ ${basename(input.file_path as string)}`;
              detail = input.file_path as string;
            } else if (toolName === 'Write' && input.file_path) {
              desc = `WRITE ${basename(input.file_path as string)}`;
              const content = (input.content as string) || '';
              detail = `${input.file_path}\n--- content (${content.split('\n').length} lines) ---\n${content.slice(0, 500)}${content.length > 500 ? '\n...' : ''}`;
            } else if (toolName === 'Edit' && input.file_path) {
              desc = `EDIT ${basename(input.file_path as string)}`;
              detail = `${input.file_path}\n- ${(input.old_string as string || '').slice(0, 100)}\n+ ${(input.new_string as string || '').slice(0, 100)}`;
            } else if (toolName === 'Bash' && input.command) {
              desc = `BASH ${(input.command as string).slice(0, 80)}`;
              detail = input.command as string;
            } else if (toolName === 'Glob' && input.pattern) {
              desc = `GLOB ${input.pattern}`;
            } else if (toolName === 'Grep' && input.pattern) {
              desc = `GREP ${input.pattern}`;
            } else if (toolName === 'WebSearch') {
              desc = `SEARCH ${(input.query as string) || ''}`;
            } else if (toolName === 'WebFetch' && input.url) {
              desc = `FETCH ${input.url}`;
            }

            emit(agent, state.currentPhase, 'tool_call', desc, detail);
          } else if (block.type === 'text') {
            const text = (block.text as string || '').trim();
            if (text) {
              emit(agent, state.currentPhase, 'text', text);
            }
          }
        }
      } else if (type === 'user') {
        const msg = event.message as Record<string, unknown>;
        const content = msg?.content as Array<Record<string, unknown>>;
        if (content) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;

            const toolUseId = block.tool_use_id as string;
            const toolName = toolNames.get(toolUseId);

            if (!block.is_error && toolName === 'StructuredOutput') {
              structured = extractStructuredSignal(block.content) || structured;
            }

            if (block.is_error) {
              const errorText = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              if (errorText) {
                emit(agent, state.currentPhase, 'permission_denied', errorText);
              }

              const strictBashAsk =
                state.securityMode === 'strict' &&
                (agent === 'C' || agent === 'D') &&
                toolName === 'Bash';

              if (strictBashAsk && !settled) {
                permissionDenied = {
                  toolName: 'Bash',
                  toolInput: toolInputs.get(toolUseId) || {},
                };
                interruptedForApproval = true;
                settled = true;
                clearActiveTurn(agent);
                resolve({
                  result: '',
                  sessionId: currentSessionId,
                  structured,
                  permissionDenied,
                  interruptedForApproval,
                  stalled,
                });
                clearInterval(stallWatcher);
                child.kill('SIGTERM');
                return;
              }
            }
          }
        }
      } else if (type === 'result') {
        lastResult = event;
        structured = extractStructuredSignal(event.structured_output, event.result) || structured;

        const usage = event.usage as Record<string, unknown>;
        if (usage) {
          state.usage.inputTokens += (usage.input_tokens as number) || 0;
          state.usage.outputTokens += (usage.output_tokens as number) || 0;
          state.usage.cacheReadTokens += (usage.cache_read_input_tokens as number) || 0;
          state.usage.cacheWriteTokens += (usage.cache_creation_input_tokens as number) || 0;
        }
        const cost = event.total_cost_usd as number;
        if (cost) state.usage.totalCostUsd += cost;
        flush();

        const denials = (event.permission_denials as Array<Record<string, unknown>> | undefined) || [];
        const bashDenial = denials.find((denial) => denial.tool_name === 'Bash');
        if (bashDenial) {
          permissionDenied = {
            toolName: 'Bash',
            toolInput: (bashDenial.tool_input as Record<string, unknown>) || {},
          };
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (settled) return;
      clearInterval(stallWatcher);

      if (code !== 0 || !lastResult) {
        clearActiveTurn(agent);
        emit('system', state.currentPhase, 'failure', `Agent ${agent} failed (exit ${code})`);
        if (stderr) console.error(stderr.slice(0, 500));
        reject(new Error(`Agent ${agent} failed with exit code ${code}`));
        return;
      }

      settled = true;
      clearActiveTurn(agent);
      resolve({
        result: (lastResult.result as string) || '',
        sessionId: (lastResult.session_id as string) || currentSessionId,
        structured,
        permissionDenied,
        interruptedForApproval,
        stalled,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      clearInterval(stallWatcher);
      clearActiveTurn(agent);
      emit('system', state.currentPhase, 'failure', `Failed to spawn agent ${agent}: ${err.message}`);
      reject(err);
    });
  });
}

async function claude(
  agent: AgentId,
  prompt: string,
  opts: {
    role: string;
    resume?: string;
    jsonSchema?: Record<string, unknown>;
  }
): Promise<{ result: string; sessionId: string; structured: Record<string, unknown> | null }> {
  let currentPrompt = prompt;
  let currentResume = opts.resume;
  let autoResumeCount = 0;

  while (true) {
    const turn = await runClaudeTurn(agent, currentPrompt, {
      role: opts.role,
      resume: currentResume,
      jsonSchema: opts.jsonSchema,
      autoResumeCount,
    });

    if (turn.stalled) {
      if (turn.sessionId && canAutoResumeTurn(agent, state.currentPhase) && autoResumeCount < MAX_AUTO_RESUMES) {
        autoResumeCount += 1;
        currentResume = turn.sessionId;
        currentPrompt = buildResumePrompt(agent, state.currentPhase);
        emit('system', state.currentPhase, 'status', `Resuming Agent ${agent} from the saved session`);
        emitSupervisor(
          state.currentPhase,
          `The ${agent === 'A' ? 'planner' : agent === 'B' ? 'reviewer' : 'agent'} looked stalled, so I resumed the saved session instead of throwing away the run.`
        );
        continue;
      }

      emit('system', state.currentPhase, 'failure', `Agent ${agent} is stalled and could not be auto-resumed`);
      throw new Error(`Agent ${agent} stalled`);
    }

    const denied = turn.permissionDenied;
    const strictBashApproval =
      state.securityMode === 'strict' &&
      (agent === 'C' || agent === 'D') &&
      denied?.toolName === 'Bash' &&
      turn.interruptedForApproval;

    if (!strictBashApproval) {
      return {
        result: turn.result,
        sessionId: turn.sessionId,
        structured: turn.structured,
      };
    }

    const pending: PendingApproval = {
      requestId: randomUUID(),
      projectDir,
      agent,
      tool: denied.toolName,
      input: denied.toolInput,
      description: buildApprovalDescription(denied.toolInput),
      createdAt: new Date().toISOString(),
      approved: null,
      sessionId: turn.sessionId,
      phase: state.currentPhase,
      reason: `Strict mode: Agent ${agent} Bash requires approval`,
    };

    writePendingApproval(projectDir, pending);
    emit('system', state.currentPhase, 'status', `Approval requested for Agent ${agent} Bash`);
    emitSupervisor(
      state.currentPhase,
      `I paused the run because strict mode needs your approval before the ${agent === 'C' ? 'coder' : 'tester'} can run Bash.`
    );

    const approved = await waitForPendingApproval(projectDir, pending.requestId);
    clearPendingApproval(projectDir, pending.requestId);
    clearApprovedBashGrant(projectDir);

    if (approved === null) {
      emit('system', state.currentPhase, 'failure', `Approval request expired for Agent ${agent}`);
      throw new Error(`Approval request expired for Agent ${agent}`);
    }

    emit(
      'system',
      state.currentPhase,
      approved ? 'approval' : 'status',
      approved ? `Approved Agent ${agent} Bash` : `Denied Agent ${agent} Bash`
    );
    emitSupervisor(
      state.currentPhase,
      approved
        ? `You approved the ${agent === 'C' ? 'coder' : 'tester'} Bash request, so I am letting the run continue.`
        : `You denied the ${agent === 'C' ? 'coder' : 'tester'} Bash request. I told the team to continue without that command if possible.`
    );

    currentResume = turn.sessionId;
    if (approved) {
      const grant: ApprovedBashGrant = {
        requestId: pending.requestId,
        projectDir,
        agent,
        command: String(denied.toolInput.command || ''),
        createdAt: new Date().toISOString(),
      };
      writeApprovedBashGrant(projectDir, grant);
      currentPrompt = 'The user approved your previous Bash request. Retry that exact command if it is still needed, then continue your task from where you left off.';
    } else {
      currentPrompt = 'The user denied your previous Bash request. Do not retry that command. Continue without it if possible, or explain exactly what is blocked.';
    }
  }
}

// ── JSON Schemas ────────────────────────────────────────────────────

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'questions'] },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'issues'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['passed', 'failed'] },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

// ── Helper ──────────────────────────────────────────────────────────

function parseSignal(result: string): Record<string, unknown> {
  // Try direct JSON parse
  try {
    return JSON.parse(result);
  } catch {
    // Try to find JSON embedded in text
    const match = result.match(/\{[\s\S]*"status"\s*:\s*"[^"]+"/);
    if (match) {
      try {
        let depth = 0;
        const start = result.indexOf(match[0]);
        for (let i = start; i < result.length; i++) {
          if (result[i] === '{') depth++;
          if (result[i] === '}') depth--;
          if (depth === 0) {
            return JSON.parse(result.slice(start, i + 1));
          }
        }
      } catch {}
    }
    // Try to detect positive/negative signals from text
    const lower = result.toLowerCase();
    if (lower.includes('all tests pass') || lower.includes('tests passed') || lower.includes('approved') || lower.includes('code is correct')) {
      emit('system', state.currentPhase, 'status', 'Parsed positive signal from text');
      return { status: 'approved' };
    }
    emit('system', state.currentPhase, 'status', 'Could not parse signal — treating as approved');
    return { status: 'approved' };
  }
}

// Normalize signal status — treat approved/passed as the same positive result
function isPositiveSignal(signal: Record<string, unknown>): boolean {
  const s = (signal.status as string || '').toLowerCase();
  return s === 'approved' || s === 'passed';
}

function buildPhase0Context() {
  const phase0Events = state.events.filter(
    (event) =>
      event.phase === 'concept' &&
      (
        event.type === 'user_msg' ||
        event.type === 'handoff' ||
        ((event.agent === 'A' || event.agent === 'S') && event.type === 'text')
      )
  );
  if (phase0Events.length === 0) return '';

  return 'Here is the Phase 0 concept conversation and supervisor context about what to build:\n\n' +
    phase0Events.map((event) => `${event.agent}: ${event.text}`).join('\n') + '\n\n';
}

function buildPlanPrompt() {
  const phase0Context = buildPhase0Context();

  return [
    phase0Context
      ? phase0Context + 'Based on the conversation above, build the plan now.'
      : `Build concept from the user: ${concept}`,
    '',
    'YOUR ONLY JOB RIGHT NOW: Write a build plan to plan.md. That is it.',
    '',
    'Follow these steps exactly:',
    '1. Read build-plan-template.md in this directory. Follow it step by step.',
    '2. Research the concept — read docs, source code, web search, verify packages.',
    `3. Write the build plan to ${join(projectDir, 'plan.md')}`,
    '4. The plan must have complete, copy-pasteable code for every file.',
    '5. No descriptions — only code. The coder must build without asking a single question.',
    '6. Do one full self-review pass. Read the plan back once as a fresh session, fill any gaps you find, then stop.',
    '7. When plan.md is complete and review-ready, say "Plan complete" and STOP.',
    '',
    'RULES:',
    '- You are ONLY writing plan.md. Do NOT write any other files.',
    '- Do NOT write index.html, app.js, or any code files. That is the CODER\'s job.',
    '- Do NOT create the actual project. Only the PLAN.',
    '- Use Read/Glob/Grep to inspect the workspace. Do NOT use Bash just to list files or inspect the project directory.',
    '- Do NOT use the Agent tool. Do NOT spawn sub-agents.',
    '- Do NOT send the plan to anyone. The orchestrator handles that.',
    '- Do not take shortcuts. Do not guess. Verify everything from source.',
  ].join('\n');
}

async function runPlanningPhase(aSession: string, options?: { resumeStalled?: boolean }): Promise<string> {
  setPhase('planning');
  setPipelineStatus('running');
  setAgent('A', 'active');

  if (options?.resumeStalled) {
    emit('system', 'planning', 'status', 'Supervisor resumed A from the saved planning session');
    emitSupervisor('planning', 'I resumed the planner from the saved session so we do not have to throw away the research and start over.');
  } else {
    emit('A', 'planning', 'status', 'Starting research and plan writing...');
    emitSupervisor('planning', 'The planner is researching and writing the build plan now. I will keep the team in planning until the plan is solid enough for review.');
  }

  const prompt = options?.resumeStalled ? buildResumePrompt('A', 'planning') : buildPlanPrompt();
  const aResult = await claude('A', prompt, {
    role: ROLE_A,
    resume: options?.resumeStalled ? (aSession || state.runtime.activeTurn?.sessionId || state.sessions.A) : undefined,
  });

  aSession = aResult.sessionId;
  saveSession('A', aSession);

  if (!existsSync(join(projectDir, 'plan.md'))) {
    emit('A', 'planning', 'failure', 'Did not write plan.md');
    throw new Error('Agent A did not write plan.md');
  }

  emit('A', 'planning', 'status', 'Plan written to plan.md');
  return aSession;
}

async function runPlanReviewPhase(
  aSession: string,
  options?: {
    resumeStalledAgent?: 'A' | 'B';
    bSession?: string;
    emitInitialSend?: boolean;
  }
): Promise<{ aSession: string; bSession?: string; reviewRound: number; paused: boolean }> {
  let bSession = options?.bSession || state.sessions.B || undefined;
  let planApproved = false;
  let reviewRound = state.events.filter(
    (event) => event.agent === 'B' && event.phase === 'plan-review' && event.type === 'status' && /^Review round \d+/.test(event.text)
  ).length;

  setPhase('plan-review');
  setPipelineStatus('running');
  setAgent('A', 'idle');
  setAgent('B', 'active');

  if (options?.emitInitialSend !== false) {
    emit('A', 'plan-review', 'send', 'Sent plan to B for review');
    emitSupervisor('plan-review', 'The planner handed the plan to the reviewer. We are still before coding, so this is the right place to catch gaps.');
  }

  if (options?.resumeStalledAgent === 'A') {
    setAgent('B', 'idle');
    setAgent('A', 'active');
    emit('system', 'plan-review', 'status', 'Supervisor resumed A during plan review');
    emitSupervisor('plan-review', 'I resumed the planner during review so the plan can keep moving without resetting the whole run.');

    const aResume = await claude('A', buildResumePrompt('A', 'plan-review'), {
      role: ROLE_A,
      resume: aSession || state.runtime.activeTurn?.sessionId || state.sessions.A,
    });
    aSession = aResume.sessionId;
    saveSession('A', aSession);

    emit('A', 'plan-review', 'answer', 'Answered questions and updated plan');
    emit('A', 'plan-review', 'send', 'Sent updated plan to B');
    setAgent('A', 'idle');
    setAgent('B', 'active');
  }

  let nextBPrompt =
    options?.resumeStalledAgent === 'B'
      ? buildResumePrompt('B', 'plan-review')
      : options?.resumeStalledAgent === 'A'
      ? [
          'A has answered your questions and updated the plan.',
          `Review the updated plan at ${join(projectDir, 'plan.md')} again.`,
          'If you still have concerns, respond with status "questions" and list them.',
          'If the plan is now bulletproof, respond with status "approved".',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
        ].join('\n')
      : [
          `Review the plan at ${join(projectDir, 'plan.md')}`,
          'Read the entire plan. Look for:',
          '- Gaps or missing details',
          '- Assumptions that are not verified',
          '- Code that looks incomplete or guessed',
          '- Anything the coder would need to interpret or ask about',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
        ].join('\n');
  let nextBResume = options?.resumeStalledAgent === 'B'
    ? (state.runtime.activeTurn?.sessionId || bSession)
    : bSession;

  while (!planApproved) {
    reviewRound += 1;
    emit('B', 'plan-review', 'status', `Review round ${reviewRound}...`);

    const bResult = await claude('B', nextBPrompt, {
      role: ROLE_B,
      resume: nextBResume,
      jsonSchema: REVIEW_SCHEMA,
    });
    bSession = bResult.sessionId;
    saveSession('B', bSession);

    const signal = bResult.structured || parseSignal(bResult.result);

    if (isPositiveSignal(signal)) {
      planApproved = true;
      emit('B', 'plan-review', 'approval', 'PLAN APPROVED');
      emitSupervisor('plan-review', 'The reviewer approved the plan. The build doctrine is locked now, so coding can start from a stable contract.');
      setAgent('B', 'done');
      break;
    }

    const questions = (signal.questions as string[]) || [];
    questions.forEach((question, index) => {
      emit('B', 'plan-review', 'question', `Q${index + 1}: ${question}`);
    });

    emit('B', 'plan-review', 'send', `Sent ${questions.length} question(s) to A`);

    setAgent('A', 'active');
    emit('A', 'plan-review', 'receive', `Received ${questions.length} question(s) from B`);

    const aFollowup = await claude('A', [
      'Agent B (Plan Reviewer) has questions about your plan:',
      '',
      ...questions.map((question, index) => `${index + 1}. ${question}`),
      '',
      'Answer each question with verified information.',
      `Update ${join(projectDir, 'plan.md')} with any corrections or additions.`,
      'Do not guess. Verify from source.',
    ].join('\n'), { role: ROLE_A, resume: aSession });
    aSession = aFollowup.sessionId;
    saveSession('A', aSession);

    emit('A', 'plan-review', 'answer', 'Answered questions and updated plan');
    emit('A', 'plan-review', 'send', 'Sent updated plan to B');
    setAgent('A', 'idle');
    setAgent('B', 'active');

    nextBPrompt = [
      'A has answered your questions and updated the plan.',
      `Review the updated plan at ${join(projectDir, 'plan.md')} again.`,
      'If you still have concerns, respond with status "questions" and list them.',
      'If the plan is now bulletproof, respond with status "approved".',
      '',
      'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
    ].join('\n');
    nextBResume = bSession;
  }

  emit('A', 'plan-review', 'status', 'Plan locked — final, unmodifiable copy');

  if (shouldStopAfterPlanReview()) {
    state.activeAgent = '';
    setPipelineStatus('paused');
    emitSupervisor(
      'plan-review',
      state.runGoal === 'plan-only'
        ? 'Planning is complete and I paused the team before coding, exactly as requested.'
        : 'I paused the team after approved plan review, so you can decide whether to continue into coding.'
    );
    emit(
      'system',
      'plan-review',
      'status',
      state.runGoal === 'plan-only'
        ? 'Plan-only run complete. Supervisor stopped after approved plan review.'
        : 'Supervisor stopped the pipeline after approved plan review.'
    );
    flush();
    return { aSession, bSession, reviewRound, paused: true };
  }

  return { aSession, bSession, reviewRound, paused: false };
}

async function runBuildFromCoding(aSession: string): Promise<{ aSession: string; codeReviewRound: number; testRound: number }> {
  setPhase('coding');
  setPipelineStatus('running');
  setAgent('C', 'active');
  emit('A', 'coding', 'send', 'Sent approved plan to C');
  emit('C', 'coding', 'receive', 'Received approved plan from A');
  emit('C', 'coding', 'status', 'Building...');
  emitSupervisor('coding', 'The coder is implementing the approved plan now. At this point the goal is execution, not re-deciding the design.');

  const cResult = await claude('C', [
    `Read the approved plan at ${join(projectDir, 'plan.md')}`,
    'Build exactly what it says. Every file, every modification, every special case.',
    'Do not improvise. Do not interpret. Do not "improve."',
    'Do not modify plan.md — it is locked.',
    'Do NOT use the Agent tool. Do NOT spawn sub-agents. Build everything yourself.',
    '',
    'When you are done, confirm what you built.',
  ].join('\n'), { role: ROLE_C });
  let cSession = cResult.sessionId;
  saveSession('C', cSession);

  emit('C', 'coding', 'status', 'Finished coding');

  setPhase('code-review');
  setAgent('C', 'idle');
  setAgent('D', 'active');
  emit('C', 'code-review', 'send', 'Sent code to D for review');
  emit('D', 'code-review', 'receive', 'Received code from C');
  emitSupervisor('code-review', 'The tester is reviewing the coder output against the approved plan before we trust the build.');

  let dSession: string | undefined;
  let codeApproved = false;
  let codeReviewRound = 0;

  while (!codeApproved) {
    codeReviewRound += 1;

    const dPrompt = dSession
      ? [
          'C has applied fixes to the code.',
          `Review the code again against the plan at ${join(projectDir, 'plan.md')}`,
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": ["..."]}',
        ].join('\n')
      : [
          `Read the plan at ${join(projectDir, 'plan.md')}`,
          'Read the code that C wrote.',
          'Check: does the code match the plan? Every item accounted for?',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": ["..."]}',
        ].join('\n');

    emit('D', 'code-review', 'status', `Code review round ${codeReviewRound}...`);

    const dResult = await claude('D', dPrompt, {
      role: ROLE_D,
      resume: dSession,
      jsonSchema: CODE_REVIEW_SCHEMA,
    });
    dSession = dResult.sessionId;
    saveSession('D', dSession);

    const signal = dResult.structured || parseSignal(dResult.result);

    if (isPositiveSignal(signal)) {
      codeApproved = true;
      emit('D', 'code-review', 'approval', 'CODE APPROVED');
    } else {
      const issues = (signal.issues as string[]) || [];

      issues.forEach((issue, index) => {
        emit('D', 'code-review', 'issue', `Issue ${index + 1}: ${issue}`);
      });

      emit('D', 'code-review', 'send', `Sent ${issues.length} issue(s) to C`);
      setAgent('C', 'active');
      emit('C', 'code-review', 'receive', `Received ${issues.length} issue(s) from D`);

      const cReviewFollowup = await claude('C', [
        'Agent D (Code Reviewer) found issues with your code:',
        '',
        ...issues.map((issue, index) => `${index + 1}. ${issue}`),
        '',
        'Fix each issue. Do not modify plan.md.',
      ].join('\n'), { role: ROLE_C, resume: cSession });
      cSession = cReviewFollowup.sessionId;
      saveSession('C', cSession);

      emit('C', 'code-review', 'fix', 'Applied fixes');
      emit('C', 'code-review', 'send', 'Sent fixed code to D');
      setAgent('C', 'idle');
    }
  }

  setPhase('testing');
  emit('D', 'testing', 'status', 'Moving to testing...');
  emitSupervisor('testing', 'Code review is done. The tester is now running the build and checking whether it actually behaves the way the plan says it should.');

  let testsPassed = false;
  let testRound = 0;

  while (!testsPassed) {
    testRound += 1;

    const testPrompt = testRound === 1
      ? [
          'Code review is complete. Now test the code.',
          'Run it. Confirm it actually works — not just that it looks right.',
          `Test all functionality against the plan at ${join(projectDir, 'plan.md')}`,
          '',
          'Respond with ONLY a JSON object: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
        ].join('\n')
      : [
          'C has applied fixes for the test failures.',
          'Re-test the code.',
          'Respond with ONLY a JSON object: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
        ].join('\n');

    emit('D', 'testing', 'status', `Test round ${testRound}...`);

    const testResult = await claude('D', testPrompt, {
      role: ROLE_D,
      resume: dSession!,
      jsonSchema: TEST_SCHEMA,
    });
    dSession = testResult.sessionId;
    saveSession('D', dSession);

    const signal = testResult.structured || parseSignal(testResult.result);

    if (isPositiveSignal(signal)) {
      testsPassed = true;
      emit('D', 'testing', 'approval', 'ALL TESTS PASSED');
      setAgent('D', 'done');
    } else {
      const failures = (signal.failures as string[]) || [];

      failures.forEach((failure, index) => {
        emit('D', 'testing', 'failure', `Failure ${index + 1}: ${failure}`);
      });

      emit('D', 'testing', 'send', `Sent ${failures.length} failure(s) to C`);
      setAgent('C', 'active');
      emit('C', 'testing', 'receive', `Received ${failures.length} failure(s) from D`);

      const cTestFollowup = await claude('C', [
        'Agent D (Tester) found test failures:',
        '',
        ...failures.map((failure, index) => `${index + 1}. ${failure}`),
        '',
        'Fix each failure. Do not modify plan.md.',
      ].join('\n'), { role: ROLE_C, resume: cSession });
      cSession = cTestFollowup.sessionId;
      saveSession('C', cSession);

      emit('C', 'testing', 'fix', 'Applied fixes');
      emit('C', 'testing', 'send', 'Sent fixed code to D');
      setAgent('C', 'done');
    }
  }

  setPhase('deploy');
  setAgent('A', 'active');
  emit('D', 'deploy', 'send', 'Sent reviewed + tested code to A');
  emit('A', 'deploy', 'receive', 'Received final code from D');
  emit('A', 'deploy', 'status', 'Deploying...');

  const aDeployResult = await claude('A', [
    'The code has been reviewed and tested by Agent D. Everything passed.',
    'Do not use Bash or git. The orchestrator will handle any final commit.',
    'Confirm the build is complete and mention any environment caveats the user should know.',
  ].join('\n'), { role: ROLE_A, resume: aSession });
  aSession = aDeployResult.sessionId;
  saveSession('A', aSession);

  setAgent('A', 'done');
  setPhase('complete');
  setPipelineStatus('complete');
  state.buildComplete = true;
  emit('A', 'deploy', 'approval', 'BUILD COMPLETE');
  emitSupervisor('complete', 'The team finished the build. You can inspect the output now or jump into any specialist chat for follow-up work.');

  try {
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', `Build complete: ${concept.slice(0, 50)}`], { cwd: projectDir });
    emit('system', 'complete', 'status', 'Code committed to git');
  } catch {}

  try {
    const files = readdirSync(projectDir);
    const htmlFile = files.find((file) => file === 'index.html') || files.find((file) => file.endsWith('.html'));
    if (htmlFile) {
      execFileSync('open', [join(projectDir, htmlFile)]);
      emit('system', 'complete', 'status', `Opened ${htmlFile}`);
    }
  } catch {}

  return { aSession, codeReviewRound, testRound };
}

// ════════════════════════════════════════════════════════════════════
//  PIPELINE EXECUTION
// ════════════════════════════════════════════════════════════════════

async function run() {
  console.log('\n\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║     PIPELINE BUILD ORCHESTRATOR (LIVE)     ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Concept:  ${concept}`);
  console.log(`  Project:  ${projectDir}`);
  console.log(`  Viewer:   http://localhost:3456\n`);

  let aSession = existingASession;
  let reviewRound = 0;
  let codeReviewRound = 0;
  let testRound = 0;

  if (existingASession && !resumingExistingProject) {
    emit('system', 'concept', 'status', `Build concept: ${concept}`);
    emit('system', 'concept', 'status', 'Phase 0 completed in viewer. Starting pipeline...');
    emitSupervisor('concept', 'I have the concept and I am starting the team from the staged conversation now.');
  } else if (!resumingExistingProject) {
    setPhase('concept');
    emit('system', 'concept', 'status', `Build concept: ${concept}`);
    emitSupervisor('concept', 'I have the concept. Once you start the run, I will hand it to the planner first.');
  } else {
    emit('system', state.currentPhase || 'concept', 'status', 'Resuming existing pipeline state');
    emitSupervisor(state.currentPhase || 'concept', 'I am resuming the existing team state from the last saved checkpoint.');
  }

  const initialPipelineStatus = state.pipelineStatus;
  const initialResumeAction = state.resumeAction || 'none';
  state.resumeAction = 'none';
  flush();
  setPipelineStatus('running');

  const stalledTurn = state.runtime.activeTurn?.status === 'stalled' ? state.runtime.activeTurn : null;

  if (initialResumeAction === 'continue-approved-plan' && state.currentPhase === 'plan-review') {
    emit('system', 'plan-review', 'status', 'Continuing from the approved plan');
    emitSupervisor('plan-review', 'I am continuing from the approved plan and handing the work into coding now.');
  } else if (initialPipelineStatus === 'paused' && state.currentPhase === 'plan-review') {
    emit('system', 'plan-review', 'status', 'Continuing from the approved plan');
    emitSupervisor('plan-review', 'The plan was already approved and paused. I am continuing the build from that checkpoint now.');
  } else if (initialResumeAction === 'resume-stalled-turn' && stalledTurn?.agent === 'A' && stalledTurn.phase === 'planning') {
    aSession = await runPlanningPhase(aSession, { resumeStalled: true });
    const review = await runPlanReviewPhase(aSession);
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (initialResumeAction === 'resume-stalled-turn' && stalledTurn?.phase === 'plan-review' && (stalledTurn.agent === 'A' || stalledTurn.agent === 'B')) {
    const review = await runPlanReviewPhase(aSession, {
      resumeStalledAgent: stalledTurn.agent,
      bSession: state.sessions.B,
      emitInitialSend: false,
    });
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (stalledTurn?.agent === 'A' && stalledTurn.phase === 'planning') {
    aSession = await runPlanningPhase(aSession, { resumeStalled: true });
    const review = await runPlanReviewPhase(aSession);
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (stalledTurn?.phase === 'plan-review' && (stalledTurn.agent === 'A' || stalledTurn.agent === 'B')) {
    const review = await runPlanReviewPhase(aSession, {
      resumeStalledAgent: stalledTurn.agent,
      bSession: state.sessions.B,
      emitInitialSend: false,
    });
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (state.currentPhase === 'plan-review' && existsSync(join(projectDir, 'plan.md'))) {
    const review = await runPlanReviewPhase(aSession, {
      bSession: state.sessions.B,
      emitInitialSend: false,
    });
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (state.currentPhase === 'concept' || state.currentPhase === 'planning') {
    aSession = await runPlanningPhase(aSession, { resumeStalled: false });
    const review = await runPlanReviewPhase(aSession);
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  }

  if (!existsSync(join(projectDir, 'plan.md'))) {
    throw new Error('plan.md is missing; cannot continue the build');
  }

  const build = await runBuildFromCoding(aSession);
  aSession = build.aSession;
  codeReviewRound = build.codeReviewRound;
  testRound = build.testRound;

  console.log('\n\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║            BUILD COMPLETE                 ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Project:       ${projectDir}`);
  console.log(`  Plan:          ${join(projectDir, 'plan.md')}`);
  console.log(`  Review rounds: ${reviewRound}`);
  console.log(`  Code reviews:  ${codeReviewRound}`);
  console.log(`  Test rounds:   ${testRound}`);
  console.log('');
}

run().catch((err) => {
  try {
    setPipelineStatus('failed');
    emitSupervisor(state.currentPhase || 'concept', `The run failed in ${state.currentPhase || 'concept'}. Ask me what happened and I can help decide whether to resume, stop, or reset.`);
  } catch {}
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
