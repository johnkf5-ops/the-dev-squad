'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { Badge } from '@/components/shared/Badge';
import { AutoGrowTextarea } from '@/components/shared/AutoGrowTextarea';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { LunarOfficeScene } from '@/components/mission/LunarOfficeScene';
import { canAutoResumeTurn } from '@/lib/pipeline-runtime';
import { getExecutionPathStatus, getSupervisorRecommendation, getSupervisorUpdate } from '@/lib/pipeline-supervisor';
import { usePipelineState, type AgentId, type AppMode, type PendingApproval, type PermissionMode, type RunGoal, type SecurityMode } from '@/lib/use-pipeline';

const AGENT_NAMES: Record<AgentId, string> = {
  A: 'Planner', B: 'Reviewer', C: 'Coder', D: 'Tester', S: 'Supervisor',
};

const PHASE_LABELS: Record<string, string> = {
  concept: 'Concept', planning: 'Planning', 'plan-review': 'Plan Review',
  coding: 'Coding', 'code-review': 'Code Review', testing: 'Testing',
  deploy: 'Deploy', complete: 'Complete',
};

const PHASE_VARIANTS: Record<string, 'purple' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  concept: 'neutral', planning: 'purple', 'plan-review': 'purple',
  coding: 'warning', 'code-review': 'warning', testing: 'danger',
  deploy: 'success', complete: 'success',
};

const PHASE_PROGRESS: Record<string, number> = {
  concept: 5, planning: 20, 'plan-review': 35,
  coding: 55, 'code-review': 70, testing: 85,
  deploy: 95, complete: 100,
};

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];

const MANUAL_ROLES: Record<string, string> = {
  A: 'Software planning & architecture',
  B: 'Code review & finding gaps',
  C: 'Writing code',
  D: 'Testing & debugging',
  S: 'Oversight & diagnostics',
};

export default function PipelinePage() {
  const [mode, setMode] = useState<AppMode>('pipeline');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-6');
  const [selectedSecurityMode, setSelectedSecurityMode] = useState<SecurityMode>('fast');
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionMode>('auto');
  const [selectedRunGoal, setSelectedRunGoal] = useState<RunGoal>('full-build');

  const {
    state, sendChat, startPipeline, resumePipeline, stopPipeline, setStopAfterReview, approveBash, getPlan, resetState, agentEvents, agentSpeech,
  } = usePipelineState({ pollInterval: 400, mode, model: selectedModel });

  const [selectedAgent, setSelectedAgent] = useState<AgentId>('S');
  const [chatInput, setChatInput] = useState('');
  const [sendingAgents, setSendingAgents] = useState<Set<AgentId>>(new Set());
  const [pipelineStarted, setPipelineStarted] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<AgentId | null>(null);
  const [panelInputs, setPanelInputs] = useState<Record<string, string>>({ A: '', B: '', C: '', D: '' });
  const [nowMs, setNowMs] = useState(() => Date.now());

  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({ A: null, B: null, C: null, D: null, S: null });
  const modalRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const prevCounts = useRef<Record<string, number>>({ A: 0, B: 0, C: 0, D: 0, S: 0 });
  const prevFeedCount = useRef(0);
  const completionNotifiedRef = useRef(false);

  const isPipeline = mode === 'pipeline';
  const hasLivePipelineActivity = Boolean(state.activeAgent || state.runtime?.activeTurn || pendingApproval);
  const pipelineRunning = isPipeline && (state.pipelineStatus === 'running' || (!state.buildComplete && (pipelineStarted || hasLivePipelineActivity)));
  const pipelinePaused = isPipeline && state.pipelineStatus === 'paused';
  const pipelineFailed = isPipeline && state.pipelineStatus === 'failed';

  // Auto-scroll: all panels, expanded modal, and live feed
  useEffect(() => {
    for (const id of ['A', 'B', 'C', 'D'] as AgentId[]) {
      const events = agentEvents(id);
      if (events.length > prevCounts.current[id]) {
        const el = panelRefs.current[id];
        if (el) el.scrollTop = el.scrollHeight;
        if (expandedAgent === id && modalRef.current) {
          modalRef.current.scrollTop = modalRef.current.scrollHeight;
        }
        prevCounts.current[id] = events.length;
      }
    }
    const sEvents = agentEvents('S');
    const sEl = panelRefs.current.S;
    if (sEvents.length > prevCounts.current.S && sEl) {
      sEl.scrollTop = sEl.scrollHeight;
      prevCounts.current.S = sEvents.length;
    }
    if (state.events.length > prevFeedCount.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
      prevFeedCount.current = state.events.length;
    }
  }, [state.events.length, agentEvents, expandedAgent]);

  // Detect pipeline completion (pipeline mode only)
  useEffect(() => {
    if (!isPipeline) return;
    if (state.buildComplete && !completionNotifiedRef.current && (pipelineStarted || !!state.projectDir)) {
      completionNotifiedRef.current = true;
      try {
        const ctx = new AudioContext();
        [523.25, 659.25].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.5);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + i * 0.15);
          osc.stop(ctx.currentTime + i * 0.15 + 0.5);
        });
      } catch {}
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('The Dev Squad', { body: 'Build complete!' });
      }
    }
  }, [state.buildComplete, isPipeline, pipelineStarted, state.projectDir]);

  // Poll for pending approvals (pipeline mode only)
  useEffect(() => {
    if (!isPipeline) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/pending?_=' + Date.now());
        const data = await res.json();
        setPendingApproval(data?.tool && data?.approved === null ? data : null);
      } catch {}
    }, 500);
    return () => clearInterval(interval);
  }, [isPipeline]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  async function handleSend() {
    if (sendingAgents.has('S') || !chatInput.trim()) return;
    setSendingAgents(prev => new Set([...prev, 'S']));
    await sendChat('S', chatInput.trim(), isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
    } : undefined);
    setChatInput('');
    setSendingAgents(prev => { const n = new Set(prev); n.delete('S'); return n; });
  }

  async function handleStartPipeline() {
    completionNotifiedRef.current = false;
    setPipelineStarted(true);
    const res = await startPipeline(selectedSecurityMode, selectedRunGoal, selectedPermissionMode);
    if (!res?.success) {
      setPipelineStarted(false);
      console.error('Pipeline failed to start:', res?.error || 'Unknown error');
    }
  }

  async function handleResumePipeline() {
    completionNotifiedRef.current = false;
    setPipelineStarted(true);
    const res = await resumePipeline();
    if (!res?.success) {
      setPipelineStarted(false);
      console.error('Pipeline failed to resume:', res?.error || 'Unknown error');
    }
  }

  async function handleViewPlan() {
    const content = await getPlan();
    setPlanContent(content);
    setShowPlan(true);
  }

  async function handleReset() {
    if (isPipeline) {
      await fetch('/api/stop-pipeline', { method: 'POST' });
    }
    await resetState();
    setPipelineStarted(false);
    completionNotifiedRef.current = false;
    setPendingApproval(null);
    setSelectedAgent('S');
    setExpandedAgent(null);
    setChatInput('');
    setShowPlan(false);
    setPlanContent(null);
    setPanelInputs({ A: '', B: '', C: '', D: '' });
  }

  async function handlePanelSend(id: AgentId) {
    const msg = panelInputs[id]?.trim();
    if (sendingAgents.has(id) || !msg) return;

    setSendingAgents(prev => new Set([...prev, id]));
    setSelectedAgent(id);
    await sendChat(id, msg, isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
    } : undefined);
    setPanelInputs(prev => ({ ...prev, [id]: '' }));
    setSendingAgents(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  async function handleExpandedSend() {
    if (!expandedAgent || sendingAgents.has(expandedAgent) || !chatInput.trim()) return;
    const msg = chatInput.trim();

    setSendingAgents(prev => new Set([...prev, expandedAgent]));
    await sendChat(expandedAgent, msg, isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
    } : undefined);
    setChatInput('');
    setSendingAgents(prev => { const n = new Set(prev); n.delete(expandedAgent!); return n; });
  }

  async function handleHandoff(fromAgent: AgentId, toAgent: AgentId) {
    const textEvents = state.events.filter(e => e.agent === fromAgent && e.type === 'text');
    if (textEvents.length === 0) return;
    let text = textEvents[textEvents.length - 1].text;
    if (text.length > 2000) text = text.slice(0, 2000) + '...(truncated)';
    const msg = `[HANDOFF:${fromAgent}→${toAgent}] ${text}\n\nReview this and continue the work.`;
    setSendingAgents(prev => new Set([...prev, toAgent]));
    await sendChat(toAgent, msg, isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
    } : undefined);
    setSendingAgents(prev => { const n = new Set(prev); n.delete(toAgent); return n; });
  }

  const phase = state.currentPhase;
  const progress = PHASE_PROGRESS[phase] || 0;
  const securityModeLocked = isPipeline && (pipelineStarted || pipelineRunning || !!state.projectDir);
  const activeSecurityMode = state.projectDir ? (state.securityMode || 'fast') : selectedSecurityMode;
  const activeRunGoal = state.projectDir ? (state.runGoal || 'full-build') : selectedRunGoal;

  // Derived stats
  const firstEventTime = state.events.length > 0 ? new Date(state.events[0].time).getTime() : 0;
  const lastEventTime = state.events.length > 0 ? new Date(state.events[state.events.length - 1].time).getTime() : 0;
  const elapsedMs = firstEventTime ? lastEventTime - firstEventTime : 0;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
  const elapsed = elapsedMs > 0 ? `${elapsedMin}m ${elapsedSec}s` : '--';

  const filesModified = new Set(
    state.events
      .filter(e => e.type === 'tool_call' && /\b(Write|Edit|CREATE|WRITE)\b/.test(e.text))
      .map(e => {
        const match = e.text.match(/(?:Write|Edit|CREATE|WRITE)\s+(\S+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
  ).size;

  const lastAction = (() => {
    const toolEvents = state.events.filter(e => e.type === 'tool_call');
    if (toolEvents.length === 0) return null;
    const last = toolEvents[toolEvents.length - 1];
    return { agent: last.agent, text: last.text.length > 50 ? last.text.slice(0, 47) + '...' : last.text };
  })();

  const errorCount = state.events.filter(e => e.type === 'issue' || e.type === 'failure').length;
  const activeTurn = state.runtime?.activeTurn || null;
  const activeTurnIdleSeconds = activeTurn
    ? Math.max(0, Math.floor((nowMs - new Date(activeTurn.lastEventAt).getTime()) / 1000))
    : 0;
  const stopAfterReviewArmed = state.stopAfterPhase === 'plan-review' || activeRunGoal === 'plan-only';
  const canResumeStalledTurn = Boolean(
    activeTurn &&
    activeTurn.status === 'stalled' &&
    activeTurn.sessionId &&
    canAutoResumeTurn(activeTurn.agent, activeTurn.phase)
  );
  const canContinueApprovedPlan = pipelinePaused && phase === 'plan-review' && !!state.events.some((event) => event.text.includes('PLAN APPROVED'));
  const supervisorRecommendation = isPipeline ? getSupervisorRecommendation(state, pendingApproval) : null;
  const supervisorUpdate = isPipeline ? getSupervisorUpdate(state, pendingApproval) : null;
  const executionPathStatus = isPipeline ? getExecutionPathStatus(state) : null;
  const modePosture = isPipeline
    ? {
        title: 'Pipeline Guardrails',
        summary: activeSecurityMode === 'strict'
          ? 'Supervisor-led team run. Strict mode asks for approval on every Coder/Tester Bash call.'
          : 'Supervisor-led team run. Fast mode keeps the team moving, but this is still guardrails, not a sandbox.',
        detail: executionPathStatus?.detail || 'Host execution is the default today. Docker isolation is built, but still alpha until subscription auth in containers is reliable.',
        tone: activeSecurityMode === 'strict' ? 'warning' : 'info',
      }
    : {
        title: 'Manual Direct Sessions',
        summary: 'You are driving the team directly. Claude permission prompts still protect each session, but pipeline role guardrails and supervisor automation are not enforcing the flow for you.',
        detail: 'Use manual mode when you want direct specialist access. Use pipeline mode when you want the build doctrine and supervisor controls around the team.',
        tone: 'info',
      };

  return (
    <div className="p-4 space-y-4">
      {/* Hero: Animation + Feed (65%) + Dashboard (35%) */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '65% 1fr' }}>
        {/* Office Scene + Live Feed below it — height driven by dashboard */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[linear-gradient(180deg,rgba(24,18,33,0.96),rgba(11,10,16,0.98))]" style={{ height: 0, minHeight: '100%' }}>
          <div className="p-2">
            <LunarOfficeScene
              activePhase={phase}
              agentStatus={state.agentStatus}
              latestSpeech={{ A: agentSpeech('A'), B: agentSpeech('B'), C: agentSpeech('C'), D: agentSpeech('D'), S: agentSpeech('S') }}
              onAgentClick={(agent) => setSelectedAgent(agent)}
            />
          </div>
          {/* Live Feed — fills remaining space below animation */}
          <div className="flex min-h-0 flex-1 flex-col border-t border-white/5">
            <div className="flex items-center justify-between px-4 py-1.5">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Live Feed</span>
              </div>
              <span className="font-mono text-[10px] text-[#333]">{state.events.length} events</span>
            </div>
            <div
              ref={feedRef}
              className="flex-1 overflow-y-auto px-4 pb-2 font-mono [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[#252530] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
            >
              {state.events.length === 0 && (
                <p className="py-4 text-center text-xs text-[#252530]">{isPipeline ? 'Waiting for pipeline events...' : 'Waiting for activity...'}</p>
              )}
              {state.events.map((e, i) => (
                <div key={i} className="flex gap-2 py-[2px] text-[11px] leading-relaxed">
                  <span className="flex-shrink-0 text-[#333]">
                    {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`flex-shrink-0 w-[18px] font-bold ${
                    e.agent === 'A' ? 'text-violet-400' :
                    e.agent === 'B' ? 'text-blue-400' :
                    e.agent === 'C' ? 'text-yellow-400' :
                    e.agent === 'D' ? 'text-red-400' :
                    e.agent === 'S' ? 'text-emerald-400' :
                    'text-slate-600'
                  }`}>{e.agent === 'system' ? '--' : e.agent}</span>
                  <div className={`min-w-0 ${
                    e.type === 'approval' ? 'font-bold text-emerald-400' :
                    e.type === 'question' ? 'text-violet-300' :
                    e.type === 'issue' || e.type === 'failure' ? 'text-red-300' :
                    e.type === 'tool_call' ? 'text-[#555]' :
                    e.type === 'user_msg' ? 'text-blue-300' :
                    e.type === 'text' ? 'text-slate-400' : 'text-[#555]'
                  }`}><MarkdownText>{e.text}</MarkdownText></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Dashboard */}
        <div className="flex flex-col gap-4 rounded-xl border border-white/10 bg-[linear-gradient(180deg,rgba(24,18,33,0.96),rgba(11,10,16,0.98))] p-5">
          {/* Title + Mode Toggle */}
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold uppercase tracking-wider text-white">The Dev Squad</h1>
                <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">Office View</p>
              </div>
              <Link
                href="/squad"
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
              >
                Open Squad View
              </Link>
            </div>
            {/* Mode Toggle */}
            <div className="mt-2 flex items-center gap-2">
              <div className="flex rounded-lg border border-white/10 bg-white/5">
                <button
                  onClick={() => setMode('pipeline')}
                  className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all ${isPipeline ? 'bg-violet-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                  style={{ borderRadius: '7px 0 0 7px' }}
                >Pipeline</button>
                <button
                  onClick={() => setMode('manual')}
                  className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all ${!isPipeline ? 'bg-blue-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                  style={{ borderRadius: '0 7px 7px 0' }}
                >Manual</button>
              </div>
              {/* Model Picker — manual mode only */}
              {!isPipeline && (
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 focus:border-blue-600 focus:outline-none"
                >
                  {MODEL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value} className="bg-[#1a1a2a]">{opt.label}</option>
                  ))}
                </select>
              )}
            </div>
            <div className={`mt-3 rounded-xl border px-3 py-3 ${
              modePosture.tone === 'warning'
                ? 'border-amber-500/30 bg-amber-500/10'
                : 'border-white/10 bg-white/5'
            }`}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">{modePosture.title}</div>
                <Badge variant={isPipeline ? (activeSecurityMode === 'strict' ? 'warning' : 'success') : 'neutral'}>
                  {isPipeline ? 'SUPERVISOR-RUN' : 'YOU-RUN'}
                </Badge>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-200">{modePosture.summary}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{modePosture.detail}</p>
            </div>
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Security Mode</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-white/10 bg-white/5">
                    <button
                      onClick={() => setSelectedSecurityMode('fast')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedSecurityMode === 'fast' ? 'bg-emerald-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Fast</button>
                    <button
                      onClick={() => setSelectedSecurityMode('strict')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedSecurityMode === 'strict' ? 'bg-amber-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >Strict</button>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {selectedSecurityMode === 'strict'
                      ? 'Every C/D Bash call needs approval'
                      : 'Safe Bash auto-runs, risky Bash asks'}
                  </span>
                </div>
              </div>
            )}
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Permission Mode</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-white/10 bg-white/5">
                    <button
                      onClick={() => setSelectedPermissionMode('auto')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedPermissionMode === 'auto' ? 'bg-emerald-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Auto</button>
                    <button
                      onClick={() => setSelectedPermissionMode('plan')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedPermissionMode === 'plan' ? 'bg-blue-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                    >Plan</button>
                    <button
                      onClick={() => setSelectedPermissionMode('dangerously-skip-permissions')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedPermissionMode === 'dangerously-skip-permissions' ? 'bg-red-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >Skip</button>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {selectedPermissionMode === 'auto'
                      ? 'AI safety classifier (requires auto mode access)'
                      : selectedPermissionMode === 'plan'
                      ? 'Asks before every tool call'
                      : 'No permission checks — wild west'}
                  </span>
                </div>
              </div>
            )}
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Supervisor Goal</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-white/10 bg-white/5">
                    <button
                      onClick={() => setSelectedRunGoal('full-build')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedRunGoal === 'full-build' ? 'bg-blue-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Full Build</button>
                    <button
                      onClick={() => setSelectedRunGoal('plan-only')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedRunGoal === 'plan-only' ? 'bg-violet-600 text-white' : 'text-[#555] hover:text-[#888]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >Plan Only</button>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {selectedRunGoal === 'plan-only'
                      ? 'Stop cleanly after B approves the plan'
                      : 'Run the full team from planning through testing'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Pipeline-only: Phase + Progress */}
          {isPipeline && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={PHASE_VARIANTS[phase] || 'neutral'}>
                  {PHASE_LABELS[phase] || phase}
                </Badge>
                {state.activeAgent && (
                  <Badge variant="purple">Agent {state.activeAgent}</Badge>
                )}
                {activeTurn?.status === 'stalled' && (
                  <Badge variant="warning">TURN STALLED</Badge>
                )}
                <Badge variant={activeSecurityMode === 'strict' ? 'warning' : 'success'}>
                  {activeSecurityMode === 'strict' ? 'STRICT' : 'FAST'}
                </Badge>
                <Badge variant={activeRunGoal === 'plan-only' ? 'purple' : 'neutral'}>
                  {activeRunGoal === 'plan-only' ? 'PLAN ONLY' : 'FULL BUILD'}
                </Badge>
                {executionPathStatus && (
                  <Badge variant={executionPathStatus.variant}>
                    {executionPathStatus.label}
                  </Badge>
                )}
                {state.stopAfterPhase === 'plan-review' && activeRunGoal === 'full-build' && (
                  <Badge variant="warning">STOP AFTER REVIEW</Badge>
                )}
                {pipelinePaused && (
                  <Badge variant="warning">PAUSED</Badge>
                )}
                {pipelineFailed && (
                  <Badge variant="danger">FAILED</Badge>
                )}
                {state.buildComplete && <Badge variant="success">COMPLETE</Badge>}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
                  <span>Progress</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-400 transition-all duration-700" style={{ width: `${progress}%` }} />
                </div>
              </div>
            </>
          )}

          {/* Manual mode: simple label */}
          {!isPipeline && (
            <div className="text-[10px] uppercase tracking-wider text-blue-400">Manual Mode — direct specialist sessions with Claude permission prompts</div>
          )}

          {/* Agent Status — both modes */}
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Agents</div>
            <div className="grid grid-cols-5 gap-2">
              {(['A', 'B', 'C', 'D', 'S'] as AgentId[]).map((id) => {
                const status = state.agentStatus[id] || 'idle';
                const isActive = status === 'active' || status === 'working';
                return (
                  <div key={id} className="flex flex-col items-center gap-1">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl border-2 text-sm font-bold transition-all ${
                      isActive
                        ? 'border-emerald-500 text-emerald-400 shadow-[0_0_12px_rgba(34,197,94,0.3)]'
                        : status === 'done'
                        ? 'border-red-500 text-red-400 shadow-[0_0_12px_rgba(239,68,68,0.3)]'
                        : 'border-[#252530] text-[#444]'
                    }`} style={{ background: '#0e0e16' }}>{id}</div>
                    <span className="text-[9px] text-slate-500">{AGENT_NAMES[id]}</span>
                    <span className={`text-[8px] font-bold uppercase ${isActive ? 'text-emerald-400' : status === 'done' ? 'text-red-400' : 'text-[#333]'}`}>{status}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pipeline-only: Stats, Last Action, Concept */}
          {isPipeline && (
            <>
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Pipeline</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">Elapsed</span><span className="text-slate-400">{elapsed}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Files</span><span className="text-slate-400">{filesModified}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Events</span><span className="text-slate-400">{state.events.length}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Errors</span><span className={errorCount > 0 ? 'text-red-400' : 'text-[#333]'}>{errorCount}</span></div>
                </div>
              </div>

              {executionPathStatus && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Execution Path</div>
                  <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                    executionPathStatus.variant === 'warning'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                      : executionPathStatus.variant === 'purple'
                      ? 'border-violet-500/30 bg-violet-500/10 text-violet-200'
                      : executionPathStatus.variant === 'success'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                      : 'border-white/10 bg-white/5 text-slate-300'
                  }`}>
                    <div className="font-semibold">{executionPathStatus.label}</div>
                    <p className="mt-1 leading-relaxed">{executionPathStatus.detail}</p>
                  </div>
                </div>
              )}

              {lastAction && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Last Action</div>
                  <div className="truncate rounded-lg bg-white/5 px-3 py-2 font-mono text-[11px]">
                    <span className={`mr-1.5 font-bold ${
                      lastAction.agent === 'A' ? 'text-violet-400' :
                      lastAction.agent === 'B' ? 'text-blue-400' :
                      lastAction.agent === 'C' ? 'text-yellow-400' :
                      lastAction.agent === 'D' ? 'text-red-400' :
                      'text-emerald-400'
                    }`}>{lastAction.agent}</span>
                    <span className="text-slate-400">{lastAction.text}</span>
                  </div>
                </div>
              )}

              {activeTurn && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Current Turn</div>
                  <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                    activeTurn.status === 'stalled'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                      : 'border-white/10 bg-white/5 text-slate-300'
                  }`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">
                        Agent {activeTurn.agent} · {PHASE_LABELS[activeTurn.phase] || activeTurn.phase}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                        idle {activeTurnIdleSeconds}s
                      </span>
                    </div>
                    <p className="mt-1 leading-relaxed">{activeTurn.promptSummary}</p>
                    {activeTurn.status === 'stalled' && (
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-amber-400">
                        {activeTurn.stallReason || 'This turn appears stalled.'}
                      </p>
                    )}
                    {activeTurn.autoResumeCount > 0 && (
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-violet-300">
                        Auto-resume attempts: {activeTurn.autoResumeCount}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {state.concept && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Concept</div>
                  <p className="text-xs leading-relaxed text-slate-400">{state.concept}</p>
                </div>
              )}

              {supervisorUpdate && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Supervisor Update</div>
                  <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                    supervisorUpdate.severity === 'warning'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                      : supervisorUpdate.severity === 'success'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                      : 'border-white/10 bg-white/5 text-slate-300'
                  }`}>
                    <div className="font-semibold">{supervisorUpdate.title}</div>
                    <p className="mt-1 leading-relaxed">{supervisorUpdate.summary}</p>
                    {supervisorUpdate.ask && (
                      <p className="mt-2 text-[11px] leading-relaxed text-slate-300/90">
                        {supervisorUpdate.ask}
                      </p>
                    )}
                    {(supervisorRecommendation?.actionLabel || supervisorRecommendation?.chatCommand) && (
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">
                        {supervisorRecommendation?.actionLabel || 'Suggested action'}
                        {supervisorRecommendation?.chatCommand ? ` · try "${supervisorRecommendation.chatCommand}"` : ''}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Controls */}
          <div>
            {isPipeline && (
              <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">
                Ask <span className="font-semibold text-emerald-400">S</span> to start, pause, continue, resume, or stop. Buttons are fallback controls, not the main workflow.
              </div>
            )}
            <div className="flex gap-2">
            {isPipeline && !pipelineRunning && !pipelinePaused && (!state.projectDir || state.currentPhase === 'concept' || state.buildComplete) && (
              <button onClick={handleStartPipeline} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-black transition hover:bg-emerald-400">
                {selectedRunGoal === 'plan-only' ? 'START PLAN ONLY' : 'START FULL BUILD'}
              </button>
            )}
            {isPipeline && pipelineRunning && (phase === 'planning' || phase === 'plan-review') && activeRunGoal === 'full-build' && (
              <button
                onClick={() => { void setStopAfterReview(!stopAfterReviewArmed); }}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-violet-500"
              >
                {stopAfterReviewArmed ? 'KEEP RUNNING AFTER REVIEW' : 'STOP AFTER REVIEW'}
              </button>
            )}
            {isPipeline && canContinueApprovedPlan && (
              <button onClick={handleResumePipeline} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500">
                CONTINUE BUILD
              </button>
            )}
            {isPipeline && canResumeStalledTurn && (
              <button onClick={handleResumePipeline} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400">
                RESUME STALLED RUN
              </button>
            )}
            <button onClick={() => { setPipelineStarted(false); completionNotifiedRef.current = false; stopPipeline(); setSendingAgents(new Set()); }} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-400">
              STOP
            </button>
            {isPipeline && state.events.some(e => e.text?.includes('plan.md')) && (
              <button onClick={handleViewPlan} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10">
                View Plan
              </button>
            )}
            <button onClick={handleReset} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-400 transition hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20">
              Reset
            </button>
          </div>
          </div>
        </div>
      </div>

      {/* 5-panel grid: S spans left column, A/B top-right, C/D bottom-right */}
      <div
        className="grid gap-px overflow-hidden rounded-xl border border-white/10 bg-[#1a1a2a]"
        style={{
          gridTemplateColumns: '30% 1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          height: '100vh',
        }}
      >
        {/* S — Supervisor, spans both rows */}
          <div className="flex cursor-pointer flex-col overflow-hidden bg-[#0c0c18]" style={{ gridRow: '1 / -1' }} onClick={() => setSelectedAgent('S')}>
            <div className="flex items-center gap-3 border-b-2 border-emerald-600 px-3.5 py-2.5">
            <div className={`flex h-9 w-9 items-center justify-center rounded-[10px] border-2 text-sm font-bold transition-all ${
              (state.agentStatus.S === 'active' || state.agentStatus.S === 'working')
                ? 'border-emerald-500 text-emerald-400 shadow-[0_0_16px_rgba(34,197,94,0.25)]'
                : 'border-[#252530] text-[#444]'
            }`} style={{ background: '#0e0e16' }}>S</div>
            <div>
              <div className="text-[13px] font-semibold text-[#999]">Supervisor</div>
              <div className="text-[10px] text-[#444]">{isPipeline ? 'Recommended front door. Direct specialist chat still works.' : 'Oversight & diagnostics'}</div>
            </div>
            {isPipeline && state.events.some(e => e.text?.includes('plan.md')) && (
              <button onClick={handleViewPlan} className="ml-auto rounded border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-white hover:bg-white/10">
                View Plan
              </button>
            )}
          </div>
          <div
            ref={(el) => { panelRefs.current.S = el; }}
            className="flex-1 space-y-px overflow-y-auto px-2.5 py-1.5 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[#252530] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
          >
            {isPipeline && supervisorUpdate && (
              <div className={`mb-2 rounded border px-2 py-1.5 text-[11px] ${
                supervisorUpdate.severity === 'warning'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  : supervisorUpdate.severity === 'success'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-white/10 bg-white/5 text-slate-300'
              }`}>
                <div className="font-semibold">{supervisorUpdate.title}</div>
                <p className="mt-1 leading-relaxed">{supervisorUpdate.summary}</p>
                {supervisorUpdate.ask && (
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">{supervisorUpdate.ask}</p>
                )}
              </div>
            )}
            {agentEvents('S').length === 0 && (
              <p className="pt-16 text-center text-xs tracking-wider text-[#252530]">{isPipeline ? 'Ask S to manage the run, or message any specialist directly.' : 'Chat with any specialist directly. Claude permission prompts still apply in manual mode.'}</p>
            )}
            {agentEvents('S').map((e, i) => (
              <div key={i} className={`rounded px-2 py-1 text-[11px] leading-relaxed ${
                e.type === 'approval' ? 'font-bold text-emerald-400' :
                e.type === 'question' ? 'text-violet-300' :
                e.type === 'issue' || e.type === 'failure' ? 'text-red-300' :
                e.type === 'tool_call' ? 'italic text-[#555]' :
                e.type === 'handoff' ? 'font-semibold text-cyan-400 italic' :
                    e.type === 'user_msg' ? 'font-semibold text-blue-300' :
                e.type === 'text' ? 'text-slate-400' : 'text-[#555]'
              }`}>
                <span className="mr-1.5 text-[9px] text-[#333]">
                  {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <MarkdownText>{e.text}</MarkdownText>
              </div>
            ))}
          </div>
          <div className="flex-shrink-0 border-t border-[#1a1a2a] px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1.5 text-[10px] text-[#444]">
              Recommended: <span className="font-semibold text-emerald-400">Supervisor first</span>
            </div>
            <div className="flex items-end gap-2">
              <AutoGrowTextarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={isPipeline
                  ? (supervisorRecommendation?.chatCommand
                      ? `Ask the supervisor anything, or try "${supervisorRecommendation.chatCommand}"`
                      : 'Ask the supervisor anything, or chat with any specialist directly...')
                  : 'Chat with the Supervisor'}
                disabled={sendingAgents.has('S')}
                className="max-h-40 flex-1 rounded-lg border border-[#252530] bg-[#14141e] px-3 py-2 text-sm text-white placeholder-[#444] focus:border-emerald-600 focus:outline-none disabled:opacity-30"
              />
              <button onClick={handleSend} disabled={sendingAgents.has('S') || !chatInput.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-30">
                Send
              </button>
            </div>
          </div>
        </div>

        {/* A, B, C, D panels */}
        {(['A', 'B', 'C', 'D'] as AgentId[]).map((id) => {
          const events = agentEvents(id);
          const status = state.agentStatus[id] || 'idle';
          const isSelected = selectedAgent === id;
          const isSending = sendingAgents.has(id);
          const AGENT_ROLES: Record<string, string> = isPipeline
            ? {
                A: 'Direct planning chat when you want to hash out the build',
                B: 'Direct review chat for plan gaps and tradeoffs',
                C: 'Direct coding/debugging chat when you want deep context',
                D: 'Direct testing/review chat for failures and fixes',
              }
            : { A: MANUAL_ROLES.A, B: MANUAL_ROLES.B, C: MANUAL_ROLES.C, D: MANUAL_ROLES.D };
          const hasTextEvents = events.some(e => e.type === 'text');
          return (
            <div
              key={id}
              onClick={() => { setSelectedAgent(id); setExpandedAgent(id); }}
              className={`flex cursor-pointer flex-col overflow-hidden transition-colors ${
                isSelected ? 'bg-[#0c0c18]' : 'bg-[#08080d] hover:bg-[#0a0a12]'
              }`}
            >
              <div className={`flex items-center gap-3 border-b-2 px-3.5 py-2.5 ${
                isSelected ? 'border-blue-600' : 'border-[#1a1a2a]'
              }`}>
                <div className={`flex h-9 w-9 items-center justify-center rounded-[10px] border-2 text-sm font-bold ${
                  status === 'active' || status === 'working'
                    ? 'border-emerald-500 text-emerald-400 shadow-[0_0_16px_rgba(34,197,94,0.25)]'
                    : status === 'done'
                    ? 'border-[#1a1a2a] text-[#333] opacity-50'
                    : 'border-[#252530] text-[#444]'
                }`} style={{ background: '#0e0e16' }}>{id}</div>
                <div className="flex-1">
                  <div className="text-[13px] font-semibold text-[#999]">{AGENT_NAMES[id]}</div>
                  <div className="text-[10px] text-[#444]">{AGENT_ROLES[id]}</div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Handoff dropdown — manual mode only, only if agent has text output */}
                  {!isPipeline && hasTextEvents && (
                    <select
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { if (e.target.value) { handleHandoff(id, e.target.value as AgentId); e.target.value = ''; } }}
                      defaultValue=""
                      disabled={sendingAgents.size > 0}
                      className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] text-blue-400 focus:outline-none disabled:opacity-30"
                    >
                      <option value="" disabled>Send to →</option>
                      {(['A', 'B', 'C', 'D'] as AgentId[]).filter(x => x !== id).map(target => (
                        <option key={target} value={target} className="bg-[#1a1a2a]">→ {AGENT_NAMES[target]}</option>
                      ))}
                    </select>
                  )}
                  {events.length > 0 && (
                    <span className="text-[10px] text-[#333]">{events.length} events</span>
                  )}
                </div>
              </div>
              {/* Events */}
              <div
                ref={(el) => { panelRefs.current[id] = el; }}
                className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {events.length === 0 && (
                  <p className="pt-8 text-center text-xs tracking-wider text-[#252530]">
                    {isPipeline ? (id === 'A' ? 'Tell A what you want to build' : 'IDLE') : `Chat with the ${AGENT_NAMES[id]}`}
                  </p>
                )}
                <div className="space-y-px">
                  {events.map((e, i) => (
                    <div key={i} className={`rounded px-2 py-1 text-[11px] leading-relaxed ${
                      e.type === 'approval' ? 'font-bold text-emerald-400' :
                      e.type === 'question' ? 'text-violet-300' :
                      e.type === 'issue' || e.type === 'failure' ? 'text-red-300' :
                      e.type === 'tool_call' ? 'italic text-[#555]' :
                      e.type === 'handoff' ? 'font-semibold text-cyan-400 italic' :
                    e.type === 'user_msg' ? 'font-semibold text-blue-300' :
                      e.type === 'text' ? 'text-slate-400' : 'text-[#555]'
                    }`}>
                      <span className="mr-1.5 text-[9px] text-[#333]">
                        {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <MarkdownText>{e.text}</MarkdownText>
                    </div>
                  ))}
                </div>
              </div>
              {/* Chat input */}
              <div className="flex-shrink-0 border-t border-[#1a1a2a] px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-end gap-1.5">
                  <AutoGrowTextarea
                    value={panelInputs[id] || ''}
                    onChange={(e) => setPanelInputs(prev => ({ ...prev, [id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handlePanelSend(id);
                      }
                    }}
                    placeholder={`Message ${AGENT_NAMES[id]}...`}
                    disabled={isSending}
                    className="max-h-32 flex-1 rounded-md border border-[#252530] bg-[#14141e] px-2.5 py-1.5 text-xs text-white placeholder-[#444] focus:border-blue-600 focus:outline-none disabled:opacity-30"
                  />
                  <button onClick={() => handlePanelSend(id)} disabled={isSending || !panelInputs[id]?.trim()} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-30">
                    Send
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Agent Detail Modal */}
      {expandedAgent && expandedAgent !== 'S' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setExpandedAgent(null)}>
          <div className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0e0e16]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-white/10 px-6 py-4">
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl border-2 text-sm font-bold ${
                (state.agentStatus[expandedAgent] === 'active' || state.agentStatus[expandedAgent] === 'working')
                  ? 'border-emerald-500 text-emerald-400 shadow-[0_0_16px_rgba(34,197,94,0.25)]'
                  : 'border-[#252530] text-[#444]'
              }`} style={{ background: '#0e0e16' }}>{expandedAgent}</div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-white">{AGENT_NAMES[expandedAgent]}</div>
                <div className="text-xs text-slate-500">{agentEvents(expandedAgent).length} events</div>
              </div>
              <button onClick={() => setExpandedAgent(null)} className="text-2xl text-slate-500 hover:text-white">&times;</button>
            </div>
            <div ref={modalRef} className="flex-1 space-y-px overflow-y-auto px-6 py-3 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[#252530] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]">
              {agentEvents(expandedAgent).map((e, i) => (
                <div key={i} className={`rounded px-3 py-1.5 text-xs leading-relaxed ${
                  e.type === 'approval' ? 'font-bold text-emerald-400' :
                  e.type === 'question' ? 'text-violet-300' :
                  e.type === 'issue' || e.type === 'failure' ? 'text-red-300' :
                  e.type === 'tool_call' ? 'italic text-[#555]' :
                  e.type === 'handoff' ? 'font-semibold text-cyan-400 italic' :
                    e.type === 'user_msg' ? 'font-semibold text-blue-300' :
                  e.type === 'text' ? 'text-slate-400' : 'text-[#555]'
                }`}>
                  <span className="mr-2 text-[10px] text-[#444]">
                    {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <MarkdownText>{e.text}</MarkdownText>
                </div>
              ))}
            </div>
            {/* Modal chat — sends to expanded agent, not S */}
            <div className="flex-shrink-0 border-t border-white/10 px-6 py-4">
              <div className="flex items-end gap-2">
                <AutoGrowTextarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleExpandedSend();
                    }
                  }}
                  placeholder={`Message ${AGENT_NAMES[expandedAgent]}...`}
                  disabled={sendingAgents.has(expandedAgent)}
                  className="max-h-40 flex-1 rounded-lg border border-[#252530] bg-[#14141e] px-3 py-2 text-sm text-white placeholder-[#444] focus:border-blue-600 focus:outline-none disabled:opacity-30"
                />
                <button onClick={handleExpandedSend} disabled={sendingAgents.has(expandedAgent) || !chatInput.trim()} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-30">
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plan Modal */}
      {showPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setShowPlan(false)}>
          <div className="max-h-[80vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/10 bg-[#0e0e16] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">plan.md</h2>
              <button onClick={() => setShowPlan(false)} className="text-2xl text-slate-500 hover:text-white">&times;</button>
            </div>
            <pre className="mt-4 whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-300">{planContent || 'No plan yet.'}</pre>
          </div>
        </div>
      )}

      {/* Approval Banner — pipeline only */}
      {isPipeline && pendingApproval && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border-2 border-amber-500 bg-[#1a1a2a] px-6 py-4 shadow-[0_0_30px_rgba(245,158,11,0.2)]">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-400">
            {activeSecurityMode === 'strict' ? 'Strict Mode' : (pendingApproval.tool as string)} — Approval Required
          </p>
          <p className="mt-2 max-w-md break-all font-mono text-sm text-amber-200">
            {pendingApproval.description || JSON.stringify(pendingApproval.input)}
          </p>
          <p className="mt-2 text-[11px] uppercase tracking-wider text-amber-500">
            Agent {pendingApproval.agent} · {pendingApproval.phase || state.currentPhase}
          </p>
          <div className="mt-3 flex gap-3">
            <button onClick={() => approveBash(true, pendingApproval)} className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400">APPROVE</button>
            <button onClick={() => approveBash(false, pendingApproval)} className="rounded-lg bg-red-500 px-5 py-2 text-sm font-bold text-white hover:bg-red-400">DENY</button>
          </div>
        </div>
      )}
    </div>
  );
}
