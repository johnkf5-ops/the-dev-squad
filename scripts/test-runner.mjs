import assert from 'node:assert/strict';

import {
  AutoRunner,
  DockerRunner,
  HostRunner,
  buildClaudeArgs,
  buildRunnerEnv,
  createRunner,
  getNetworkProfile,
  getProjectMountMode,
  shouldPreferDocker,
} from '../pipeline/runner.ts';

const roleArgs = buildClaudeArgs({
  prompt: 'build me a tiny app',
  projectDir: '/tmp/project',
  model: 'claude-opus-4-6',
  roleFile: '/tmp/role.md',
  resume: 'sess-123',
  effort: 'high',
  jsonSchema: { type: 'object' },
});

assert.deepEqual(roleArgs.slice(0, 8), [
  '-p', 'build me a tiny app',
  '--permission-mode', 'auto',
  '--model', 'claude-opus-4-6',
  '--output-format', 'stream-json',
]);
assert.ok(roleArgs.includes('--system-prompt-file'));
assert.ok(roleArgs.includes('/tmp/role.md'));
assert.ok(roleArgs.includes('--resume'));
assert.ok(roleArgs.includes('sess-123'));
assert.ok(roleArgs.includes('--effort'));
assert.ok(roleArgs.includes('high'));
assert.ok(roleArgs.includes('--json-schema'));

const promptArgs = buildClaudeArgs({
  prompt: 'hello',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
});
assert.ok(promptArgs.includes('--system-prompt'));
assert.ok(promptArgs.includes('You are helpful.'));

const env = buildRunnerEnv({
  prompt: 'hello',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
  pipelineAgent: 'C',
  securityMode: 'strict',
  extraEnv: { TEST_ONLY: '1' },
});
assert.equal(env.PIPELINE_AGENT, 'C');
assert.equal(env.PIPELINE_SECURITY_MODE, 'strict');
assert.equal(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');
assert.equal(env.TEST_ONLY, '1');

assert.equal(shouldPreferDocker({ pipelineAgent: 'C' }), true);
assert.equal(shouldPreferDocker({ pipelineAgent: 'D' }), true);
assert.equal(shouldPreferDocker({ pipelineAgent: 'A' }), false);
assert.equal(getProjectMountMode('B'), 'ro');
assert.equal(getProjectMountMode('D'), 'rw');
assert.equal(getNetworkProfile('A'), 'research');
assert.equal(getNetworkProfile('C'), 'build');
assert.equal(getNetworkProfile('S'), 'none');

assert.ok(createRunner('host') instanceof HostRunner);
assert.ok(createRunner('auto') instanceof AutoRunner);
assert.equal(typeof new DockerRunner().isAvailable(), 'boolean');

console.log('runner checks passed');
