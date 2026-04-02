import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { NextRequest, NextResponse } from 'next/server';
import { createRunner, type PipelineAgentId, type RunnerOptions } from '../../../../pipeline/runner.ts';
import { EMPTY_RUNTIME } from '@/lib/pipeline-runtime';
import { readPendingApproval } from '@/lib/pipeline-approval';
import { buildSupervisorSnapshot, getSupervisorRecommendation } from '@/lib/pipeline-supervisor';
import { buildSupervisorConceptReply, looksLikeStatusQuestion } from '@/lib/supervisor-concept';
import {
  appendPipelineEvent,
  resumePipelineRun,
  setStopAfterReview,
  startPipelineRun,
  stopPipelineRun,
  type RunGoal,
  type SecurityMode,
} from '@/lib/pipeline-control';
import { parseSupervisorIntent } from '@/lib/supervisor-intents';

const BUILDUI_DIR = resolve(process.cwd(), 'pipeline');
const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');
const ROLE_A_PHASE0 = join(BUILDUI_DIR, 'role-a-phase0.md');
const ROLE_FILES: Record<string, string> = {
  A: join(BUILDUI_DIR, 'role-a.md'),
  B: join(BUILDUI_DIR, 'role-b.md'),
  C: join(BUILDUI_DIR, 'role-c.md'),
  D: join(BUILDUI_DIR, 'role-d.md'),
  S: join(BUILDUI_DIR, 'role-s.md'),
};

const MANUAL_PROMPTS: Record<string, string> = {
  A: 'You specialize in software planning and architecture.',
  B: 'You specialize in code review and finding gaps.',
  C: 'You specialize in writing code.',
  D: 'You specialize in testing and debugging.',
  S: 'You help oversee and diagnose issues.',
};

const runner = createRunner();

function getManualState(): Record<string, unknown> {
  const eventsFile = join(MANUAL_DIR, 'manual-state.json');
  if (existsSync(eventsFile)) {
    try { return JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  }
  mkdirSync(MANUAL_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: MANUAL_DIR,
    currentPhase: 'concept',
    securityMode: 'fast',
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    runtime: { ...EMPTY_RUNTIME },
    events: [],
  };
  writeFileSync(eventsFile, JSON.stringify(fresh, null, 2));
  return fresh;
}

function getStagingState(): Record<string, unknown> {
  const eventsFile = join(STAGING_DIR, 'pipeline-events.json');
  if (existsSync(eventsFile)) {
    try { return JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  }
  mkdirSync(STAGING_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: '',
    currentPhase: 'concept',
    securityMode: 'fast',
    activeAgent: '',
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    sessions: {},
    buildComplete: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    runtime: { ...EMPTY_RUNTIME },
    events: [],
  };
  writeFileSync(eventsFile, JSON.stringify(fresh, null, 2));
  return fresh;
}

function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter((name: string) => name !== '.staging' && name !== '.manual')
      .map((name: string) => join(BUILDS_DIR, name))
      .filter((p: string) => {
        try { return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile(); }
        catch { return false; }
      })
      .sort((a: string, b: string) => statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs);
    return dirs[0] || null;
  } catch { return null; }
}

function writeState(file: string, state: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function appendUserEvent(state: Record<string, unknown>, agent: string, message: string) {
  const events = (state.events as Array<Record<string, unknown>>) || [];
  events.push({
    time: new Date().toISOString(),
    agent,
    phase: state.currentPhase || 'concept',
    type: 'user_msg',
    text: `You: ${message}`,
  });
  state.events = events;
}

function appendSupervisorFailureAndGuidance(
  state: Record<string, unknown>,
  file: string,
  errorText: string
) {
  const events = (state.events as Array<Record<string, unknown>>) || [];
  events.push({
    time: new Date().toISOString(),
    agent: 'S',
    phase: state.currentPhase || 'concept',
    type: 'failure',
    text: errorText,
  });

  const recommendation = getSupervisorRecommendation(state, null);
  events.push({
    time: new Date().toISOString(),
    agent: 'S',
    phase: state.currentPhase || 'concept',
    type: 'text',
    text: `${recommendation.title}: ${recommendation.detail}${recommendation.chatCommand ? ` Try: "${recommendation.chatCommand}".` : ''}`,
  });
  state.events = events;
  writeState(file, state);
}

// ── Shared: stream claude output into a state file ──────────────────

function streamClaude(
  opts: RunnerOptions,
  eventsFile: string,
  agent: string,
  sessionId: string,
): Promise<NextResponse> {
  return new Promise<NextResponse>((resolveResponse) => {
    const child = runner.spawn(opts);

    const rl = createInterface({ input: child.stdout });
    let newSessionId = sessionId;

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }

      const type = event.type as string;

      if (type === 'system') {
        const streamedSessionId = (event.session_id as string) || '';
        if (streamedSessionId) {
          newSessionId = streamedSessionId;
          try {
            const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
            if (!s.sessions) s.sessions = {};
            s.sessions[agent] = streamedSessionId;
            writeFileSync(eventsFile, JSON.stringify(s, null, 2));
          } catch {}
        }
      }

      if (type === 'assistant') {
        const msg = event.message as Record<string, unknown>;
        const content = msg?.content as Array<Record<string, unknown>>;
        if (!content) return;

        for (const block of content) {
          if (block.type === 'tool_use') {
            const toolName = block.name as string;
            const input = block.input as Record<string, unknown>;
            let desc = toolName;
            if (toolName === 'Read' && input.file_path) desc = `Reading: ${basename(input.file_path as string)}`;
            else if (toolName === 'Write' && input.file_path) desc = `Writing: ${basename(input.file_path as string)}`;
            else if (toolName === 'Edit' && input.file_path) desc = `Editing: ${basename(input.file_path as string)}`;
            else if (toolName === 'Bash' && input.command) desc = `Running: ${(input.command as string).slice(0, 80)}`;

            try {
              const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
              s.events.push({ time: new Date().toISOString(), agent, phase: s.currentPhase || 'concept', type: 'tool_call', text: desc });
              writeFileSync(eventsFile, JSON.stringify(s, null, 2));
            } catch {}
          } else if (block.type === 'text') {
            const text = ((block.text as string) || '').trim();
            if (text) {
              try {
                const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
                s.events.push({ time: new Date().toISOString(), agent, phase: s.currentPhase || 'concept', type: 'text', text });
                writeFileSync(eventsFile, JSON.stringify(s, null, 2));
              } catch {}
            }
          }
        }
      } else if (type === 'result') {
        newSessionId = (event.session_id as string) || sessionId;
        try {
          const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
          if (!s.sessions) s.sessions = {};
          s.sessions[agent] = newSessionId;
          const usage = event.usage as Record<string, number>;
          if (usage && s.usage) {
            s.usage.inputTokens = (s.usage.inputTokens || 0) + (usage.input_tokens || 0);
            s.usage.outputTokens = (s.usage.outputTokens || 0) + (usage.output_tokens || 0);
            s.usage.cacheReadTokens = (s.usage.cacheReadTokens || 0) + (usage.cache_read_input_tokens || 0);
            s.usage.cacheWriteTokens = (s.usage.cacheWriteTokens || 0) + (usage.cache_creation_input_tokens || 0);
          }
          const cost = event.total_cost_usd as number;
          if (cost && s.usage) s.usage.totalCostUsd = (s.usage.totalCostUsd || 0) + cost;
          writeFileSync(eventsFile, JSON.stringify(s, null, 2));
        } catch {}
      }
    });

    child.on('close', () => {
      // Set agent back to idle
      try {
        const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
        if (s.agentStatus) s.agentStatus[agent] = 'idle';
        writeFileSync(eventsFile, JSON.stringify(s, null, 2));
      } catch {}
      resolveResponse(NextResponse.json({ success: true, sessionId: newSessionId }));
    });
    child.on('error', () => {
      resolveResponse(NextResponse.json({ success: false }, { status: 500 }));
    });
  });
}

// ── Manual mode ─────────────────────────────────────────────────────

function handleManual(agent: string, message: string, model: string) {
  const eventsFile = join(MANUAL_DIR, 'manual-state.json');
  const state = getManualState();
  const sessions = (state.sessions as Record<string, string>) || {};
  const sessionId = sessions[agent] || '';

  // Set agent active
  const agentStatus = (state.agentStatus as Record<string, string>) || {};
  agentStatus[agent] = 'active';
  state.agentStatus = agentStatus;

  // Append event — detect handoffs vs regular user messages
  const events = (state.events as Array<Record<string, unknown>>) || [];
  const handoffMatch = message.match(/^\[HANDOFF:(\w)→(\w)\]\s/);
  if (handoffMatch) {
    const fromAgent = handoffMatch[1];
    const handoffText = message.replace(/^\[HANDOFF:\w→\w\]\s/, '').replace(/\n\nReview this and continue the work\.$/, '');
    events.push({ time: new Date().toISOString(), agent: fromAgent, phase: 'concept', type: 'handoff', text: `→ ${agent}: ${handoffText}` });
  } else {
    events.push({ time: new Date().toISOString(), agent, phase: 'concept', type: 'user_msg', text: `You: ${message}` });
  }
  state.events = events;
  writeFileSync(eventsFile, JSON.stringify(state, null, 2));

  const safeMessage = message.startsWith('-') ? 'User says: ' + message : message;

  return streamClaude(
    {
      prompt: safeMessage,
      projectDir: MANUAL_DIR,
      model,
      resume: sessionId || undefined,
      systemPrompt: sessionId ? undefined : (MANUAL_PROMPTS[agent] || MANUAL_PROMPTS.A),
    },
    eventsFile,
    agent,
    sessionId
  );
}

// ── Pipeline mode ───────────────────────────────────────────────────

function handlePipeline(
  agent: string,
  message: string,
  defaults?: { securityMode?: SecurityMode; runGoal?: RunGoal }
) {
  let projectDir: string;
  let eventsFile: string;

  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  const activeProject = findLatestProject();

  if (existsSync(stagingEvents)) {
    projectDir = STAGING_DIR;
    eventsFile = stagingEvents;
  } else if (activeProject) {
    const projState = JSON.parse(readFileSync(join(activeProject, 'pipeline-events.json'), 'utf8'));
    const phase = projState.currentPhase as string;
    const isActive = phase && phase !== 'concept' && !projState.buildComplete;
    const isDone = !!projState.buildComplete;
    if (isActive || isDone) {
      projectDir = activeProject;
      eventsFile = join(activeProject, 'pipeline-events.json');
    } else {
      projectDir = STAGING_DIR;
      eventsFile = stagingEvents;
      getStagingState();
    }
  } else {
    projectDir = STAGING_DIR;
    eventsFile = stagingEvents;
    getStagingState();
  }

  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  const securityMode = state.securityMode === 'strict' ? 'strict' : 'fast';
  const sessions = (state.sessions as Record<string, string>) || {};
  const sessionId = sessions[agent] || '';

  if (agent === 'S') {
    const intent = parseSupervisorIntent(message);
    if (intent) {
      let controlProjectDir = projectDir;
      let controlEventsFile = eventsFile;
      let controlState = state;

      if (intent.action === 'start-run') {
        controlProjectDir = STAGING_DIR;
        controlEventsFile = join(STAGING_DIR, 'pipeline-events.json');
        controlState = getStagingState();

        if (!controlState.concept && typeof intent.concept === 'string' && intent.concept.trim()) {
          controlState.concept = intent.concept.trim();
        }
      }

      appendUserEvent(controlState, agent, message);
      writeState(controlEventsFile, controlState);

      if (intent.action === 'start-run') {
        const effectiveSecurityMode = intent.securityMode || defaults?.securityMode || (controlState.securityMode === 'strict' ? 'strict' : 'fast');
        const effectiveRunGoal = intent.runGoal || defaults?.runGoal || 'full-build';
        const result = startPipelineRun({
          securityMode: effectiveSecurityMode,
          runGoal: effectiveRunGoal,
        });

        if (!result.success) {
          appendSupervisorFailureAndGuidance(
            controlState,
            controlEventsFile,
            result.error || 'Supervisor could not start the run'
          );
          return NextResponse.json({ success: false, error: result.error || 'Could not start pipeline' });
        }

        appendPipelineEvent(result.projectDir!, {
          agent: 'S',
          phase: 'concept',
          type: 'status',
          text:
            result.runGoal === 'plan-only'
              ? `Supervisor started plan-only mode in ${result.securityMode} mode. A will plan, B will review, then the run will pause.`
              : `Supervisor started the full build in ${result.securityMode} mode.`,
        });

        return NextResponse.json({
          success: true,
          controlAction: 'start-run',
          projectDir: result.projectDir,
          runGoal: result.runGoal,
          securityMode: result.securityMode,
        });
      }

      if (intent.action === 'set-stop-after-review') {
        const result = setStopAfterReview(intent.enabled, controlProjectDir === STAGING_DIR ? undefined : controlProjectDir);
        if (!result.success) {
          appendSupervisorFailureAndGuidance(
            controlState,
            controlEventsFile,
            result.error || 'Supervisor could not update stop-after-review'
          );
          return NextResponse.json({ success: false, error: result.error || 'Could not update supervisor control' });
        }

        return NextResponse.json({
          success: true,
          controlAction: 'set-stop-after-review',
          stopAfterPhase: result.stopAfterPhase,
          projectDir: result.projectDir,
        });
      }

      if (intent.action === 'resume-run') {
        const result = resumePipelineRun(controlProjectDir === STAGING_DIR ? undefined : controlProjectDir);
        if (!result.success) {
          appendSupervisorFailureAndGuidance(
            controlState,
            controlEventsFile,
            result.error || 'Supervisor could not resume the run'
          );
          return NextResponse.json({ success: false, error: result.error || 'Could not resume pipeline' });
        }

        return NextResponse.json({
          success: true,
          controlAction: result.action || 'resume-run',
          projectDir: result.projectDir,
        });
      }

      if (intent.action === 'stop-run') {
        const result = stopPipelineRun(controlProjectDir === STAGING_DIR ? undefined : controlProjectDir);
        appendPipelineEvent(result.projectDir || controlProjectDir, {
          agent: 'S',
          phase: String(controlState.currentPhase || 'concept'),
          type: 'status',
          text: 'Supervisor stopped the run',
        });
        return NextResponse.json({ success: true, controlAction: 'stop-run', projectDir: result.projectDir });
      }
    }

    const isConceptPhase =
      projectDir === STAGING_DIR &&
      (!state.currentPhase || state.currentPhase === 'concept') &&
      !state.buildComplete;

    if (isConceptPhase) {
      const shouldUpdateConcept = !looksLikeStatusQuestion(message) || !state.concept;
      if (shouldUpdateConcept) {
        state.concept = message.trim();
      }

      appendUserEvent(state, agent, message);
      const reply = buildSupervisorConceptReply(String(state.concept || ''), shouldUpdateConcept);
      const events = (state.events as Array<Record<string, unknown>>) || [];
      events.push({
        time: new Date().toISOString(),
        agent: 'S',
        phase: state.currentPhase || 'concept',
        type: 'text',
        text: reply,
      });
      state.events = events;
      writeState(eventsFile, state);

      return NextResponse.json({
        success: true,
        conceptCaptured: shouldUpdateConcept,
        concept: state.concept,
      });
    }
  }

  if (!state.concept && message) {
    state.concept = message;
    writeState(eventsFile, state);
  }

  const currentPhase = state.currentPhase as string;
  const isPhase0 = !currentPhase || currentPhase === 'concept';
  const roleFile = (agent === 'A' && isPhase0) ? ROLE_A_PHASE0 : (ROLE_FILES[agent] || ROLE_FILES.A);

  const safeMessage = message.startsWith('-') ? 'User says: ' + message : message;
  const buildComplete = !!state.buildComplete;
  let finalMessage = safeMessage;
  if (agent === 'S') {
    const pendingApproval = projectDir !== STAGING_DIR ? readPendingApproval(projectDir) : null;
    finalMessage = [
      buildSupervisorSnapshot(state, pendingApproval),
      '',
      'Use the live snapshot above as the source of truth for the team state.',
      'Answer as the supervisor/operator for the dev team.',
      'Lead with one concrete recommendation when the user asks what to do next.',
      '',
      safeMessage,
    ].join('\n');
  }
  if (buildComplete) {
    finalMessage = '[The build pipeline has completed. The user is chatting with you directly for post-build work — reviewing, fixing, or modifying the project.]\n\n' + finalMessage;
  }

  appendUserEvent(state, agent, message);
  writeState(eventsFile, state);

  return streamClaude(
    {
      prompt: finalMessage,
      projectDir,
      pipelineDir: BUILDUI_DIR,
      model: 'claude-opus-4-6',
      roleFile,
      resume: sessionId || undefined,
      pipelineAgent: agent as PipelineAgentId,
      securityMode,
    },
    eventsFile,
    agent,
    sessionId
  );
}

// ── Route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { agent, message, mode, model, securityMode, runGoal } = await req.json();

  if (mode === 'manual') {
    return handleManual(agent, message, model || 'claude-sonnet-4-6');
  }
  return handlePipeline(agent, message, {
    securityMode: securityMode === 'strict' ? 'strict' : 'fast',
    runGoal: runGoal === 'plan-only' ? 'plan-only' : 'full-build',
  });
}
