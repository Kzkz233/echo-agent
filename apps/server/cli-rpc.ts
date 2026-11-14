import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { version } from '../../packages/contracts/version.ts';
import { characterActive } from '../../packages/kernel/characters.ts';
import type { Application } from './application.ts';
import { buildInfo } from '../../packages/contracts/build.ts';
import { attachmentInput } from '../../packages/contracts/execution.ts';

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
  const manage = { kind: 'cli' as const, permissions: new Set(['system.read', 'system.write', 'knowledge.read', 'knowledge.write', 'semantic.read', 'semantic.write', 'files.read']) };
  const management: Record<string, string> = {
    'pipeline.status': 'knowledge.pipeline.status', 'pipeline.save': 'knowledge.pipeline.save',
    'migration.plan': 'semantic.migration.plan', 'migration.start': 'semantic.migration.start', 'migration.status': 'semantic.migration.status',
    'migration.pause': 'semantic.migration.pause', 'migration.resume': 'semantic.migration.resume', 'migration.rollback': 'semantic.migration.rollback',
    'knowledge.vaults': 'knowledge.vaults', 'knowledge.import': 'knowledge.import-job', 'knowledge.search': 'knowledge.search', 'knowledge.inspect': 'knowledge.graph',
    'lifecycle.request': 'system.lifecycle.request', 'lifecycle.status': 'system.lifecycle.status', 'lifecycle.cancel': 'system.lifecycle.cancel',
    'update.check': 'updates.check', 'update.stage': 'updates.stage', 'update.status': 'updates.status', 'update.rollback': 'updates.rollback',
  };
  if (management[method]) return app.registry.call(management[method], params, manage);
  if (method === 'commands') { z.object({}).parse(params); return app.cli.list(); }
  if (method === 'command') { const v = z.object({ id: z.string(), input: z.unknown().default({}) }).parse(params); return app.cli.call(v.id, v.input); }
  if (method === 'jobs') { z.object({}).parse(params); return app.jobs.list(); }
  if (method === 'job.control') { const v = z.object({ id: z.string(), action: z.enum(['pause', 'resume', 'cancel']) }).parse(params); return app.jobs.control(v.id, v.action, new AbortController().signal); }
  if (method === 'plugins') { z.object({}).parse(params); return [...app.plugins.plugins.values()].map(p => ({ id: p.manifest.id, version: p.manifest.version, enabled: app.plugins.active.has(p.manifest.id) })); }
  if (method === 'models') { z.object({}).parse(params); return app.router.inference.models().map(m => ({ id: m.id, name: m.name, generation: m.generation, embedding: m.embedding, transcription: m.transcription })); }
  if (method === 'mcp') { z.object({}).parse(params); return app.externalMcp.list().map(({ id, name, enabled }: any) => ({ id, name, enabled })); }
  if (method === 'logs') { const v = z.object({ runId: z.string().optional(), limit: z.number().int().min(1).max(200).default(30) }).parse(params); return v.runId ? app.router.execution.list(v.runId) : app.store.db.prepare('SELECT id,data FROM runs ORDER BY rowid DESC LIMIT ?').all(v.limit).map((r: any) => { const j = JSON.parse(r.data); return { id: r.id, state: j.state, error: j.error, createdAt: j.createdAt }; }); }
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
    case 'status':
      z.strictObject({}).parse(params);
      return { version, build: buildInfo, updates: await app.updates.status(), lifecycle: app.lifecycle.status(), backend: 'ready', dataDirectory: app.runtime, platform: process.platform,
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
      const run = value.requestId ? (await app.jobs.list()).find(j => j.requestId === value.requestId && (!j.taskId || j.taskId === value.id) && (!j.taskType || j.taskType === value.type)) : undefined;
      return { ...item, requestId: value.requestId,
        ...(method === 'task.run' ? { accepted: true, state: 'accepted' } : {}),
        ...(run ? { runId: run.nativeId, jobId: run.id, state: run.state, error: run.error } : {}),
        tracking: Boolean(run) };
    }
    case 'chat.send': {
      const value = z.object({ ...target.shape, ...submission.shape, text: z.string().trim().min(1).max(100000), attachments: z.array(attachmentInput.omit({ conversationId: true })).max(4).default([]) }).parse(params);
      const { role, conversationId } = target.parse(value);
      const selected = conversationId ?? roles().find((item) => item.id === role)?.conversationId;
      const conversation = selected ? app.store.conversation(selected) : undefined;
      invariant(conversation && !['worker', 'group-member'].includes(conversation.kind ?? ''),
        'conversation_missing', 'Choose an existing role or ordinary conversation.');
      const attachmentIds: string[] = [];
      for (const file of value.attachments) attachmentIds.push((await app.router.attachments.add(conversation.id, file.name, file.mediaType, file.data)).id);
      const receipt = await app.registry.call('conversations.send', {
        conversationId: conversation.id, text: value.text, requestId: value.requestId,
        attachmentIds,
      }, principal) as object;
      return { ...receipt, conversationId: conversation.id };
    }
    case 'chat.status': {
      const { requestId } = submission.parse(params);
      const receipt = app.store.receipt('input-' + requestId);
      invariant(receipt?.kind === 'input', 'input_missing', 'Chat request not found.');
      const run = app.store.run(requestId);
      const outputs = run ? (app.store.db.prepare(`SELECT o.data FROM documents o JOIN messages m ON json_extract(o.data,'$.messageId')=m.id
        WHERE o.namespace='outputs' AND json_extract(m.data,'$.runId')=? ORDER BY m.seq`).all(run.id) as any[]).map(row => JSON.parse(row.data)) : [];
      const deliveries = outputs.flatMap(output => app.deliveries.rows(output.id).map(receipt => ({ id: receipt.id, outputId: output.id, targetId: receipt.targetId, state: receipt.state, text: output.text, parts: output.parts })));
      const delivered = deliveries.filter(row => row.targetId === 'core.chat' && row.state === 'delivered');
      return { requestId, conversationId: receipt.input.conversationId, runId: run?.id,
        state: run?.state ?? receipt.state, text: delivered.length ? delivered.map(row => (row.parts ?? [row.text]).join('\n\n')).join('\n\n') : run?.result,
        deliveries, pendingApprovals: app.router.interactions.list(receipt.input.conversationId).map(item => ({ id: item.id, kind: item.kind })), error: run?.error ?? receipt.error };
    }
    default:
      invariant(false, 'cli_method', 'This operation is unavailable through the CLI.');
  }
}
