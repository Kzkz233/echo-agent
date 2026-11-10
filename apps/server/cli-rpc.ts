import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { version } from '../../packages/contracts/version.ts';
import { characterActive } from '../../packages/kernel/characters.ts';
import type { Application } from './application.ts';

const task = z.object({ type: id, id });
const submission = z.object({ requestId: id });
const target = z.object({ role: id.optional(), conversationId: id.optional() }).refine(
  ({ role, conversationId }) => Boolean(role) !== Boolean(conversationId),
  'Specify exactly one role or conversation.',
);
const principal = { kind: 'cli' as const, permissions: new Set([
  'automation.read', 'automation.write', 'conversation.write',
]) };

export async function cliRequest(app: Application, method: string, params: unknown) {
  const roles = () => app.store.documents<{ id: string; name: string }>('personas').map((role) => {
    const main = app.store.document<{ mainConversationId: string }>('characters', role.id)?.mainConversationId
      ?? app.store.conversations().find((c) => c.personaId === role.id && c.kind === 'main')?.id;
    const binding = main ? app.store.binding(main) : undefined;
    const profile = binding ? app.store.document<{ model: string }>('profiles', binding.profileId) : undefined;
    return { id: role.id, name: role.name, enabled: characterActive(app.store, role.id),
      conversationId: main, model: profile?.model, binding: binding?.state };
  });
  const tasks = async () => {
    const catalog = await app.registry.call('automation.catalog', {}, principal) as {
      types: Array<{ id: string; canRun: boolean; items: Array<{
        id: string; name: string; state: string; enabled: boolean; personaId?: string;
        suspendedByCharacter?: boolean; lastAt?: string; nextAt?: number;
      }> }>;
      unavailable: string[];
    };
    return { tasks: catalog.types.flatMap((type) => type.items.map((item) => ({
      type: type.id, id: item.id, name: item.name, state: item.state, enabled: item.enabled,
      personaId: item.personaId, lastAt: item.lastAt, nextAt: item.nextAt,
      canRun: type.canRun && !item.suspendedByCharacter,
    }))), unavailable: catalog.unavailable };
  };
  switch (method) {
    case 'doctor':
      z.strictObject({}).parse(params);
      return { version, backend: 'ready', dataDirectory: app.runtime, platform: process.platform,
        architecture: process.arch, roles: roles().map(({ name, ...role }) => role),
        plugins: [...app.plugins.active.keys()].sort() };
    case 'roles':
      z.strictObject({}).parse(params);
      return roles();
    case 'tasks':
      z.strictObject({}).parse(params);
      return tasks();
    case 'task.status':
    case 'task.run': {
      const value = task.extend({ requestId: id.optional() }).parse(params);
      const item = (await tasks()).tasks.find((item) => item.type === value.type && item.id === value.id);
      invariant(item, 'task_missing', 'Automation task not found.');
      if (method === 'task.run') {
        invariant(item.canRun, 'task_unavailable', 'This task cannot be run manually.');
        const { requestId } = submission.parse(value);
        await app.registry.call('automation.run', { ...value, requestId }, principal);
      }
      const review = value.type === 'review.policies' && value.requestId
        ? app.reviews.jobs().find((job) => job.key === value.requestId && job.policy?.id === value.id)
        : undefined;
      return { ...item, requestId: value.requestId,
        ...(method === 'task.run' ? { accepted: true, state: 'accepted' } : {}),
        ...(review ? { runId: review.id, state: review.state, error: review.error } : {}) };
    }
    case 'chat.send': {
      const value = z.object({ ...target.shape, ...submission.shape, text: z.string().trim().min(1).max(100000) }).parse(params);
      const { role, conversationId } = target.parse(value);
      const selected = conversationId ?? roles().find((item) => item.id === role)?.conversationId;
      const conversation = selected ? app.store.conversation(selected) : undefined;
      invariant(conversation && !['worker', 'group-member'].includes(conversation.kind ?? ''),
        'conversation_missing', 'Choose an existing role or ordinary conversation.');
      const receipt = await app.registry.call('conversations.send', {
        conversationId: conversation.id, text: value.text, requestId: value.requestId,
      }, principal) as object;
      return { ...receipt, conversationId: conversation.id };
    }
    case 'chat.status': {
      const { requestId } = submission.parse(params);
      const receipt = app.store.receipt('input-' + requestId);
      invariant(receipt?.kind === 'input', 'input_missing', 'Chat request not found.');
      const run = app.store.run(requestId);
      return { requestId, conversationId: receipt.input.conversationId, runId: run?.id,
        state: run?.state ?? receipt.state, text: run?.result, error: run?.error ?? receipt.error };
    }
    default:
      invariant(false, 'cli_method', 'This operation is unavailable through the CLI.');
  }
}
