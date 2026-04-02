#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const hookPath = join(repoRoot, 'pipeline', '.claude', 'hooks', 'approval-gate.sh');

const tempRoot = mkdtempSync(join(tmpdir(), 'dev-squad-hook-'));
const tempHome = join(tempRoot, 'home');
const buildsDir = join(tempHome, 'Builds');
const projectDir = join(buildsDir, 'contract-project');
const siblingDir = join(buildsDir, 'sibling-project');
const approvedBashGrantFile = join(projectDir, 'pipeline-approved-bash.json');

mkdirSync(projectDir, { recursive: true });
mkdirSync(siblingDir, { recursive: true });
mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
writeFileSync(join(projectDir, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'planning' }, null, 2));
writeFileSync(join(projectDir, 'plan.md'), '# plan\n');
writeFileSync(join(projectDir, 'index.html'), '<!doctype html>\n');
writeFileSync(join(projectDir, '.claude', 'settings.json'), '{}\n');
writeFileSync(join(siblingDir, 'other.txt'), 'hello\n');

function invokeHook({
  agent,
  toolName,
  toolInput = {},
  cwd = projectDir,
  securityMode = 'fast',
}) {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
  });

  const result = spawnSync('bash', [hookPath], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tempHome,
      PIPELINE_AGENT: agent,
      PIPELINE_SECURITY_MODE: securityMode,
    },
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function getDecision(stdout) {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.hookSpecificOutput?.permissionDecision ?? null;
  } catch {
    return null;
  }
}

function formatResult(result) {
  const parts = [];
  if (result.stdout) parts.push(`stdout=${JSON.stringify(result.stdout)}`);
  if (result.stderr) parts.push(`stderr=${JSON.stringify(result.stderr)}`);
  parts.push(`status=${result.status}`);
  return parts.join(' ');
}

function writeApprovedBashGrant(agent, command) {
  writeFileSync(approvedBashGrantFile, JSON.stringify({
    requestId: 'test-grant',
    projectDir,
    agent,
    command,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

const checks = [
  {
    name: 'A can read plan.md',
    expect: 'allow',
    run: () => invokeHook({ agent: 'A', toolName: 'Read', toolInput: { file_path: 'plan.md' } }),
  },
  {
    name: 'A can use WebSearch',
    expect: 'allow',
    run: () => invokeHook({ agent: 'A', toolName: 'WebSearch', toolInput: { query: 'mdn canvas api' } }),
  },
  {
    name: 'A can use WebFetch',
    expect: 'allow',
    run: () => invokeHook({ agent: 'A', toolName: 'WebFetch', toolInput: { url: 'https://developer.mozilla.org/' } }),
  },
  {
    name: 'A can write relative plan.md during planning',
    expect: 'allow',
    run: () => invokeHook({ agent: 'A', toolName: 'Write', toolInput: { file_path: 'plan.md', content: '# plan\n' } }),
  },
  {
    name: 'A cannot run Bash',
    expect: 'deny',
    run: () => invokeHook({ agent: 'A', toolName: 'Bash', toolInput: { command: 'pwd' } }),
  },
  {
    name: 'B can use StructuredOutput',
    expect: 'allow',
    run: () => invokeHook({ agent: 'B', toolName: 'StructuredOutput', toolInput: {} }),
  },
  {
    name: 'B can use WebSearch',
    expect: 'allow',
    run: () => invokeHook({ agent: 'B', toolName: 'WebSearch', toolInput: { query: 'anthropic structured outputs' } }),
  },
  {
    name: 'B can use WebFetch',
    expect: 'allow',
    run: () => invokeHook({ agent: 'B', toolName: 'WebFetch', toolInput: { url: 'https://platform.claude.com/docs/' } }),
  },
  {
    name: 'B cannot write files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'B', toolName: 'Write', toolInput: { file_path: 'plan.md', content: 'nope' } }),
  },
  {
    name: 'C can write code in current project',
    expect: 'allow',
    run: () => invokeHook({ agent: 'C', toolName: 'Write', toolInput: { file_path: 'index.html', content: '<!doctype html>\n' } }),
  },
  {
    name: 'C cannot modify plan.md',
    expect: 'deny',
    run: () => invokeHook({ agent: 'C', toolName: 'Write', toolInput: { file_path: 'plan.md', content: 'nope' } }),
  },
  {
    name: 'C cannot write to sibling project',
    expect: 'deny',
    run: () => invokeHook({
      agent: 'C',
      toolName: 'Write',
      toolInput: { file_path: join(siblingDir, 'other.txt'), content: 'nope' },
    }),
  },
  {
    name: 'C can run Bash in fast mode',
    expect: 'allow',
    run: () => invokeHook({ agent: 'C', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'fast' }),
  },
  {
    name: 'C Bash asks in strict mode',
    expect: 'ask',
    run: () => invokeHook({ agent: 'C', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' }),
  },
  {
    name: 'C approved Bash runs once in strict mode',
    expect: 'allow',
    run: () => {
      writeApprovedBashGrant('C', 'pwd');
      return invokeHook({ agent: 'C', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' });
    },
  },
  {
    name: 'C approved Bash grant is consumed after one use',
    expect: 'ask',
    run: () => invokeHook({ agent: 'C', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' }),
  },
  {
    name: 'D can use StructuredOutput',
    expect: 'allow',
    run: () => invokeHook({ agent: 'D', toolName: 'StructuredOutput', toolInput: {} }),
  },
  {
    name: 'D cannot write files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'D', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'nope' } }),
  },
  {
    name: 'D can run Bash in fast mode',
    expect: 'allow',
    run: () => invokeHook({ agent: 'D', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'fast' }),
  },
  {
    name: 'D Bash asks in strict mode',
    expect: 'ask',
    run: () => invokeHook({ agent: 'D', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' }),
  },
  {
    name: 'D approved Bash runs once in strict mode',
    expect: 'allow',
    run: () => {
      writeApprovedBashGrant('D', 'pwd');
      return invokeHook({ agent: 'D', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' });
    },
  },
  {
    name: 'C cannot use WebSearch',
    expect: 'deny',
    run: () => invokeHook({ agent: 'C', toolName: 'WebSearch', toolInput: { query: 'mdn canvas api' } }),
  },
  {
    name: 'D cannot use WebFetch',
    expect: 'deny',
    run: () => invokeHook({ agent: 'D', toolName: 'WebFetch', toolInput: { url: 'https://developer.mozilla.org/' } }),
  },
  {
    name: 'Unknown tools are deny-by-default',
    expect: 'deny',
    run: () => invokeHook({ agent: 'A', toolName: 'CronCreate', toolInput: {} }),
  },
];

let failures = 0;

for (const check of checks) {
  const result = check.run();
  const decision = getDecision(result.stdout);

  let passed = false;
  if (check.expect === 'allow') passed = decision === 'allow';
  if (check.expect === 'ask') passed = decision === 'ask';
  if (check.expect === 'deny') passed = result.status === 2;

  if (passed) {
    console.log(`PASS ${check.name}`);
  } else {
    failures++;
    console.error(`FAIL ${check.name}`);
    console.error(`  expected=${check.expect} actualDecision=${decision ?? 'none'} ${formatResult(result)}`);
  }
}

rmSync(tempRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nHook contract failed: ${failures} check(s) failed.`);
  process.exit(1);
}

console.log(`\nHook contract passed: ${checks.length} check(s).`);
