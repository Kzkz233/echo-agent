import { z } from 'zod';
import type { Application } from './application.ts';
import { ApiBackend } from '../../packages/backends/api.ts';
import { invariant, profileSchema } from '../../packages/contracts/index.ts';
import { chatSetup, chatServicePresets } from '../../packages/contracts/chat-setup.ts';

function service(input: z.infer<typeof chatSetup>) {
  const preset = input.provider === 'custom' ? { name: 'Custom API', endpoint: input.endpoint, protocol: input.protocol ?? 'openai-completions' } : chatServicePresets[input.provider];
  invariant(preset.endpoint, 'missing_endpoint', '请填写模型服务地址');
  const url = new URL(preset.endpoint);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  invariant(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (local && url.protocol === 'http:')), 'insecure_endpoint', '远程 API 需要 HTTPS；本机接口可用 HTTP');
  return { name: input.provider === 'custom' ? url.host : preset.name, endpoint: url.href.replace(/\/$/, ''), protocol: preset.protocol, local };
}
export function registerChatSetup(app: Application) {
  const saving = new Set<string>();
  app.registry.register({ name: 'models.setupCatalog', owner: 'core', description: '列出待连接服务的模型', mcp: false,
    permission: 'system.write', input: chatSetup, output: z.unknown(), run: async input => {
      const target = service(input);
      const api = new ApiBackend(async () => input.secret, app.modelNetwork.fetch);
      return api.listModels(profileSchema.parse({ id: 'preview', kind: 'api', ...target, timeoutMs: 20000 }));
    } });
  app.registry.register({ name: 'models.setupChat', owner: 'core', description: '连接聊天模型', mcp: false,
    permission: 'system.write', input: chatSetup.extend({ requestId: z.string().uuid(), model: z.string().trim().min(1).max(300) }),
    output: z.object({ id: z.string() }), run: async input => {
      const target = service(input), catalog = app.router.inference;
      const connectionId = 'service-' + input.requestId, id = 'chat-' + input.requestId, reference = 'connection-' + connectionId;
      invariant(!saving.has(id), 'setup_busy', '正在保存连接'); saving.add(id);
      let createdConnection = false, createdSecret = false;
      try {
        const own = catalog.connections().find(c => c.id === connectionId);
        if (own) {
          invariant(own.adapterId === 'core.api' && own.config.endpoint === target.endpoint && own.config.protocol === target.protocol, 'setup_conflict', '连接信息已改变，请重新添加');
          const existing = catalog.models().find(m => m.id === id && m.connectionId === connectionId);
          if (existing) { invariant(existing.model === input.model, 'setup_conflict', '该连接已保存其他模型'); return { id }; }
        }
        if (input.secret) { await app.secrets.set(reference, input.secret); createdSecret = !own; }
        if (!own) {
          await catalog.saveConnection({ id: connectionId, name: target.name, adapterId: 'core.api', purposes: ['generation'], deployment: target.local ? 'local' : 'cloud',
            config: { endpoint: target.endpoint, protocol: target.protocol, ...(input.secret ? { apiKeyRef: reference } : {}) } });
          createdConnection = true;
        }
        await catalog.saveModel({ id, name: input.model.slice(0,100), connectionId, model: input.model, generation: { enabled: true, inputs: ['text'] } });
        app.events.emit('connections.changed', {});
        return { id };
      } catch (error) {
        if (createdConnection) app.store.remove('connections', connectionId);
        if (createdSecret) await app.secrets.remove(reference);
        throw error;
      } finally { saving.delete(id); }
    } });
}
