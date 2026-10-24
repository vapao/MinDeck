import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadClaudeSkills } from './claude';

test('manual-only skills remain callable without exposing built-in session commands', async () => {
  const skill = (name: string, builtin?: boolean) => ({ name, description: name, argumentHint: '', ...(builtin ? { builtin } : {}) });
  const skills = await reloadClaudeSkills({
    reloadSkills: async () => ({ skills: [skill('commit'), skill('simplify', true)] }),
    supportedCommands: async () => [
      skill('commit'), skill('lead-dev'), skill('cross-review'), skill('simplify', true),
      skill('clear', true), skill('model', true), skill('compact', true),
    ],
  });
  assert.deepEqual(skills.map((s) => s.name), ['commit', 'simplify', 'lead-dev', 'cross-review']);
});
