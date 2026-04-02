import { execFileSync, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

export type PipelineAgentId = 'A' | 'B' | 'C' | 'D' | 'S';
export type RunnerMode = 'host' | 'docker' | 'auto';

export interface RunnerOptions {
  prompt: string;
  projectDir: string;
  pipelineDir?: string;
  model: string;
  roleFile?: string;
  systemPrompt?: string;
  resume?: string;
  jsonSchema?: Record<string, unknown>;
  effort?: string;
  pipelineAgent?: PipelineAgentId;
  securityMode?: 'fast' | 'strict';
  extraEnv?: NodeJS.ProcessEnv;
  templateFiles?: string[];
}

export type RunnerChild = Pick<
  ChildProcessWithoutNullStreams,
  'stdout' | 'stderr' | 'on' | 'kill'
>;

export interface Runner {
  spawn(opts: RunnerOptions): RunnerChild;
  cleanup(projectDir: string): Promise<void>;
  isAvailable(): boolean;
}

const DOCKER_IMAGE = 'dev-squad-agent:latest';

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function projectHash(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
}

export function shouldPreferDocker(opts: RunnerOptions): boolean {
  return opts.pipelineAgent === 'C' || opts.pipelineAgent === 'D';
}

export function getProjectMountMode(agent?: PipelineAgentId): 'rw' | 'ro' {
  switch (agent) {
    case 'B':
      return 'ro';
    case 'A':
    case 'C':
    case 'D':
    case 'S':
    default:
      return 'rw';
  }
}

export function getNetworkProfile(agent?: PipelineAgentId): 'research' | 'build' | 'none' {
  switch (agent) {
    case 'A':
    case 'B':
      return 'research';
    case 'C':
    case 'D':
      return 'build';
    default:
      return 'none';
  }
}

export function buildClaudeArgs(opts: RunnerOptions): string[] {
  if (!hasValue(opts.roleFile) && !hasValue(opts.systemPrompt)) {
    throw new Error('RunnerOptions requires either roleFile or systemPrompt');
  }

  const args: string[] = [
    '-p', opts.prompt,
    '--permission-mode', 'auto',
    '--model', opts.model,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (hasValue(opts.roleFile)) {
    args.push('--system-prompt-file', opts.roleFile);
  } else if (hasValue(opts.systemPrompt)) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (hasValue(opts.effort)) {
    args.push('--effort', opts.effort);
  }

  if (hasValue(opts.resume)) {
    args.push('--resume', opts.resume);
  }

  if (opts.jsonSchema) {
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }

  return args;
}

function buildContainerClaudeArgs(opts: RunnerOptions): string[] {
  const args: string[] = [
    '-p', opts.prompt,
    '--permission-mode', 'auto',
    '--model', opts.model,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (hasValue(opts.roleFile)) {
    args.push('--system-prompt-file', '/opt/pipeline/role.md');
  } else if (hasValue(opts.systemPrompt)) {
    args.push('--system-prompt', opts.systemPrompt);
  } else {
    throw new Error('RunnerOptions requires either roleFile or systemPrompt');
  }

  if (hasValue(opts.effort)) {
    args.push('--effort', opts.effort);
  }

  if (hasValue(opts.resume)) {
    args.push('--resume', opts.resume);
  }

  if (opts.jsonSchema) {
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }

  return args;
}

export function buildRunnerEnv(opts: RunnerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.extraEnv,
    // Reset Claude's working directory after each Bash command so a `cd`
    // does not persist into later Write/Edit tool calls.
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
  };

  if (hasValue(opts.pipelineAgent)) {
    env.PIPELINE_AGENT = opts.pipelineAgent;
  }

  if (hasValue(opts.securityMode)) {
    env.PIPELINE_SECURITY_MODE = opts.securityMode;
  }

  return env;
}

function buildDockerArgs(opts: RunnerOptions): string[] {
  const agentLabel = opts.pipelineAgent || 'session';
  const containerProject = `/home/node/Builds/${basename(opts.projectDir)}`;
  const containerName = `devsquad-${projectHash(opts.projectDir)}-${agentLabel}-${Date.now()}`;
  const sessionVolume = `devsquad-sessions-${projectHash(opts.projectDir)}-${agentLabel}`;
  const projectAccess = getProjectMountMode(opts.pipelineAgent);
  const dockerArgs: string[] = [
    'run', '--rm', '-i',
    '--name', containerName,
    '-v', `${opts.projectDir}:${containerProject}:${projectAccess}`,
    '-v', `${sessionVolume}:/home/node/.claude`,
    '--memory', '4g',
    '--cpus', '2',
    '-w', containerProject,
  ];

  if (hasValue(opts.pipelineDir) && existsSync(`${opts.pipelineDir}/.claude/hooks`)) {
    dockerArgs.push('-v', `${opts.pipelineDir}/.claude/hooks:${containerProject}/.claude/hooks:ro`);
  }

  if (hasValue(opts.pipelineDir) && existsSync(`${opts.pipelineDir}/.claude/settings.json`)) {
    dockerArgs.push('-v', `${opts.pipelineDir}/.claude/settings.json:${containerProject}/.claude/settings.json:ro`);
  }

  if (hasValue(opts.roleFile)) {
    dockerArgs.push('-v', `${opts.roleFile}:/opt/pipeline/role.md:ro`);
  }

  for (const file of opts.templateFiles || []) {
    if (!existsSync(file)) continue;
    dockerArgs.push('-v', `${file}:/opt/pipeline/${basename(file)}:ro`);
  }

  dockerArgs.push('--cap-add=NET_ADMIN', '--cap-add=NET_RAW');
  dockerArgs.push('-e', 'ANTHROPIC_API_KEY');

  if (hasValue(opts.pipelineAgent)) {
    dockerArgs.push('-e', `PIPELINE_AGENT=${opts.pipelineAgent}`);
  }

  if (hasValue(opts.securityMode)) {
    dockerArgs.push('-e', `PIPELINE_SECURITY_MODE=${opts.securityMode}`);
  }

  dockerArgs.push('-e', 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1');
  dockerArgs.push('-e', `AGENT_NETWORK_PROFILE=${getNetworkProfile(opts.pipelineAgent)}`);
  dockerArgs.push(DOCKER_IMAGE, 'claude', ...buildContainerClaudeArgs(opts));

  return dockerArgs;
}

export class HostRunner implements Runner {
  spawn(opts: RunnerOptions): RunnerChild {
    return nodeSpawn('claude', buildClaudeArgs(opts), {
      cwd: opts.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildRunnerEnv(opts),
    });
  }

  async cleanup(_projectDir: string): Promise<void> {
    void _projectDir;
  }

  isAvailable(): boolean {
    return true;
  }
}

export class DockerRunner implements Runner {
  spawn(opts: RunnerOptions): RunnerChild {
    return nodeSpawn('docker', buildDockerArgs(opts), {
      cwd: opts.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    });
  }

  async cleanup(projectDir: string): Promise<void> {
    const pid = projectHash(projectDir);
    const agents: Array<PipelineAgentId | 'session'> = ['A', 'B', 'C', 'D', 'S', 'session'];
    for (const agent of agents) {
      try {
        execFileSync('docker', ['volume', 'rm', '-f', `devsquad-sessions-${pid}-${agent}`], { stdio: 'pipe' });
      } catch {
        // Ignore missing volumes.
      }
    }
  }

  isAvailable(): boolean {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
      execFileSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  unavailableReason(): string {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
    } catch {
      return 'Docker is not running or not installed.';
    }

    try {
      execFileSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' });
    } catch {
      return `Docker image '${DOCKER_IMAGE}' not found. Build it with: docker build -t ${DOCKER_IMAGE} -f pipeline/Dockerfile.agent pipeline/`;
    }

    return '';
  }
}

export class AutoRunner implements Runner {
  private readonly host = new HostRunner();
  private readonly docker = new DockerRunner();
  private warned = false;

  spawn(opts: RunnerOptions): RunnerChild {
    if (shouldPreferDocker(opts)) {
      if (this.docker.isAvailable()) {
        return this.docker.spawn(opts);
      }
      this.warnUnavailable();
    }

    return this.host.spawn(opts);
  }

  async cleanup(projectDir: string): Promise<void> {
    if (this.docker.isAvailable()) {
      await this.docker.cleanup(projectDir);
    }
  }

  isAvailable(): boolean {
    return true;
  }

  private warnUnavailable() {
    if (this.warned) return;
    const reason = this.docker.unavailableReason();
    console.warn(`\x1b[33m[WARNING] ${reason}\x1b[0m`);
    console.warn('\x1b[33m[WARNING] Falling back to host runner for sandbox-eligible agents.\x1b[0m');
    this.warned = true;
  }
}

export function createRunner(mode: RunnerMode | string = process.env.PIPELINE_RUNNER || 'auto'): Runner {
  const requested = String(mode).toLowerCase() as RunnerMode;

  if (requested === 'host') {
    return new HostRunner();
  }

  if (requested === 'docker') {
    const docker = new DockerRunner();
    if (!docker.isAvailable()) {
      throw new Error(docker.unavailableReason());
    }
    return docker;
  }

  return new AutoRunner();
}
