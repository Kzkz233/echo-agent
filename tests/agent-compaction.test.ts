import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCompactor } from '../packages/backends/agent-compaction.ts';
import { profileSchema } from '../packages/contracts/index.ts';

test('ongoing tool-loop compaction preserves tool call/result pairs and reuses its summary', async () => {
  let calls = 0;
  const compact = agentCompactor({ profile: profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'pi', contextChars: 10000, maxOutputTokens: 512 }),
    policy: { triggerTokens: 1800, keepRecentPercent: 40 }, summarize: async () => { calls++; return 'SAFE SUMMARY'; } });
  const system = { role: 'system', content: 'ROLE' };
  const messages: any[] = [system, { role: 'user', content: 'old '.repeat(3000) },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'call-1', content: 'RESULT' },
    { role: 'assistant', content: 'Recent message' }];
  const result = await compact(messages);
  assert.equal(result[0], system);
  assert.match(JSON.stringify(result), /SAFE SUMMARY/);
  for (const message of result.filter(message => message.role === 'toolResult'))
    assert(result.some(candidate => candidate.role === 'assistant' && candidate.content.some((part: any) => part.id === message.toolCallId)));
  const before = calls;
  await compact(messages);
  assert.equal(calls, before);
});
