import { rmSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextRequest, NextResponse } from 'next/server';
import {
  clearApprovedBashGrant,
  clearPendingApproval,
} from '@/lib/pipeline-approval';

const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');

export async function POST(req: NextRequest) {
  try {
    let mode = 'pipeline';
    try {
      const body = await req.json();
      mode = body.mode || 'pipeline';
    } catch {}

    if (mode === 'manual') {
      // Manual mode — just delete the .manual directory
      if (existsSync(MANUAL_DIR)) {
        rmSync(MANUAL_DIR, { recursive: true, force: true });
      }
      return NextResponse.json({ ok: true });
    }

    // Pipeline mode — clear staging + reset active projects
    if (existsSync(STAGING_DIR)) {
      rmSync(STAGING_DIR, { recursive: true, force: true });
    }

    try {
      const dirs = readdirSync(BUILDS_DIR)
        .filter(name => name !== '.staging' && name !== '.manual')
        .map(name => join(BUILDS_DIR, name))
        .filter(p => {
          try { return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile(); }
          catch { return false; }
        });

      for (const dir of dirs) {
        try {
          const eventsFile = join(dir, 'pipeline-events.json');
          const state = JSON.parse(readFileSync(eventsFile, 'utf8'));
          const shouldReset =
            state.currentPhase !== 'concept' ||
            state.pipelineStatus === 'running' ||
            state.pipelineStatus === 'paused' ||
            state.pipelineStatus === 'failed' ||
            state.pipelineStatus === 'complete' ||
            !!state.buildComplete;

          if (shouldReset) {
            state.currentPhase = 'concept';
            state.projectDir = '';
            state.concept = '';
            state.activeAgent = '';
            state.buildComplete = false;
            state.pipelineStatus = 'idle';
            state.stopAfterPhase = 'none';
            state.resumeAction = 'none';
            state.agentStatus = { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' };
            state.sessions = {};
            state.events = [];
            state.usage = {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalCostUsd: 0,
            };
            if (state.runtime && typeof state.runtime === 'object') {
              state.runtime.activeTurn = null;
            }
            clearPendingApproval(dir);
            clearApprovedBashGrant(dir);
            writeFileSync(eventsFile, JSON.stringify(state, null, 2));
          } else {
            clearPendingApproval(dir);
            clearApprovedBashGrant(dir);
          }
        } catch {}
      }
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
