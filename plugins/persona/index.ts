import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { z } from 'zod';
import { personaSchema, invariant, type Persona } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Files } from '../files/index.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { Characters } from './characters.ts';

export class Personas {
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly files: Files,
  ) {}
  get(id: string) {
    return this.store.document<Persona>('personas', id);
  }
  async save(persona: Persona) {
    const vault = this.files.available
      ? await this.files.managed('persona', 'Persona Library')
      : undefined;
    if (vault)
      await this.files.entries.save(
        vault.id,
        persona.name,
        persona.prompt,
        {
          id: `persona-${persona.id}`,
          path: `Personas/${persona.id}/persona.md`,
          kind: 'persona',
          metadata: {
            persona: {
              id: persona.id,
            },
          },
        },
        'persona',
      );
    this.store.put('personas', persona.id, persona);
    this.router.events.emit('personas.updated',{id:persona.id});
    return persona;
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      references: (id) =>
        this.store
          .documents<{ mainConversationId: string }>('characters')
          .filter((role) => role.mainConversationId === id)
          .map(() => ({ label: '角色主会话', page: 'character', role: 'channel' })),
      activate: async (ctx) => {
        const { registry, capabilities } = ctx;
        new Characters(this.store, this.router, this.router.events, (value) =>
          this.save(value),
        ).activate(ctx);
        if (!this.store.documents('personas').length)
          await this.save({
            id: 'companion',
            name: 'Echo',
            prompt:
              '你是一位友善、坦诚、有自己看法的陪伴者。自然交流，结合已经知道的事实；不知道时直接说明。',
          });
        this.router.context(
          {
            id: 'persona',
            blocks: [{ id: 'persona.profile', layer: 'stable', label: '角色人设', worker: 'default' }],
            prepare: ({ conversation }) => ({
              'persona.profile': [{ text: this.get(conversation.personaId)?.prompt ?? '' }],
            }),
          },
          capabilities,
        );
        registry.register({
          name: 'persona.list',
          description: '列出角色',
          owner: 'persona',
          permission: 'persona.read',
          mcp: true,
          input: z.object({}),
          output: z.array(personaSchema),
          run: (_v, caller) =>
            this.store
              .documents<Persona>('personas')
              .filter((persona) => !caller.personaId || persona.id === caller.personaId)
              .map((v) => personaSchema.parse(v)),
        });
        registry.register({
          name: 'persona.save',
          description: '保存角色设定',
          owner: 'persona',
          permission: 'persona.write',
          mcp: false,
          input: personaSchema,
          output: personaSchema,
          run: (v) => this.save(v),
        });
        registry.register({
          name: 'persona.portrait.prepare',
          description: '将本地头像规范为便携的角色图片',
          owner: 'persona',
          permission: 'persona.write',
          mcp: false,
          input: z.object({ data: z.string().max(8000000) }),
          output: z.object({ portrait: personaSchema.shape.portrait.unwrap() }),
          run: async ({ data }, _caller, signal) => {
            signal.throwIfAborted();
            const sharp = (await import('sharp')).default;
            const source = sharp(Buffer.from(data, 'base64'), {
              limitInputPixels: 40000000,
              animated: false,
            });
            const info = await source.metadata();
            invariant(
              ['png', 'jpeg', 'webp', 'gif', 'avif'].includes(info.format ?? ''),
              'portrait_format',
              '请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片。',
            );
            const normalized = await source
              .rotate()
              .resize(256, 256, { fit: 'cover' })
              .webp({ quality: 88 })
              .toBuffer();
            signal.throwIfAborted();
            return { portrait: 'data:image/webp;base64,' + normalized.toString('base64') };
          },
        });
      },
    };
  }
}
