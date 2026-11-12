import manifest from './echo-plugin.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, invariant, type Persona, type ReplyImage } from '../../packages/contracts/index.ts';
import { characterEnabled, characterFeature, characterSettings } from '../../packages/kernel/characters.ts';
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import type { Router } from '../../packages/kernel/router.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { Files } from '../files/index.ts';
import { operations } from '../shared.ts';

const catalog = z.object({
  personaId: id,
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  label: z.string().trim().min(1).max(80),
  meaning: z.string().trim().min(1).max(300),
  enabled: z.boolean().default(true),
});
type Entry = z.infer<typeof catalog> & { image: ReplyImage };
const provider = 'chatstick.image';
const marker = /(?:^|\n)[ \t]*\[ECHO_STICKER:([a-z][a-z0-9_-]{0,39})\][ \t]*$/;
const markerLines = /^[ \t]*\[ECHO_STICKER:[^\r\n]*\][ \t]*\r?\n?/gm;
const eligible = (source?: string) => !source || source === 'human' || source === 'care';
const settings = z.object({ channels: z.record(id, z.boolean()).default({}) });
const emptyContext = { 'chatstick.catalog': [], 'chatstick.targets': [] };

export function chatStickPlugin(store: Store, files: Files, router: Router): Plugin {
  const rowId = (personaId: string, key: string) => personaId + ':' + key;
  const entries = (personaId: string) => store.documents<Entry>('chatstick')
    .filter((entry) => entry.personaId === personaId);
  const channels = (personaId: string) => settings.parse(characterSettings(store, personaId, 'chatstick', {})).channels;
  const latestImage = (conversationId: string, targetId: string) => store.db.prepare(
    "SELECT json_extract(data,'$.meta.image.hash') hash FROM messages WHERE conversation_id=? AND json_extract(data,'$.role')='assistant' AND EXISTS (SELECT 1 FROM json_each(data,'$.meta.delivery.targets') WHERE json_extract(value,'$.id')=?) ORDER BY seq DESC LIMIT 1",
  ).get(conversationId, targetId)?.hash;
  return {
    manifest: defineManifest(manifest),
    character: characterFeature(store, 'chatstick', settings, []),
    activate: (ctx) => {
      const op = operations(ctx, 'chatstick');
      op('list', '列出角色聊天表情', z.object({ personaId: id }), 'chatstick.read',
        (v) => entries(v.personaId), false);
      op('save', '导入或保存角色聊天表情', catalog.extend({
        data: z.string().max(11184812).optional(),
        replace: z.boolean().default(false),
      }), 'chatstick.write', async ({ data, replace, ...value }, signal) => {
          invariant(store.document('personas', value.personaId), 'persona_missing', '角色不存在。');
          const key = rowId(value.personaId, value.key);
          const previous = store.document<Entry>('chatstick', key);
          invariant(!previous || replace, 'chatstick_exists', '此表情编号已存在，请编辑原条目。');
          invariant(previous || entries(value.personaId).length < 32, 'chatstick_limit', '每个角色最多配置 32 张聊天表情。');
          let image = previous?.image;
          if (data !== undefined) {
            const raw = Buffer.from(data, 'base64');
            invariant(raw.length && raw.length <= 8 * 1024 * 1024 && raw.toString('base64') === data,
              'chatstick_image', '请选择有效且不超过 8 MB 的图片。');
            const sharp = (await import('sharp')).default;
            const bytes = await sharp(raw, { limitInputPixels: 12000000 }).rotate()
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
            signal.throwIfAborted();
            const vault = await files.managed('chatstick', 'ChatStick Images');
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (!await files.record('chatstick-' + hash)) {
              await files.write(vault.id, hash + '.png', bytes, { id: 'chatstick-' + hash, kind: 'derived' }, signal);
            }
            image = { provider, vaultId: vault.id, hash, label: value.label };
          }
          invariant(image, 'chatstick_image', '请为新表情选择一张图片。');
          signal.throwIfAborted();
          const entry = { ...value, image: { ...image, label: value.label } };
          store.put('chatstick', key, entry);
          return entry;
        }, false);
      op('remove', '从角色表情清单移除', catalog.pick({ personaId: true, key: true }), 'chatstick.write',
        (v) => { store.remove('chatstick', rowId(v.personaId, v.key)); return { removed: true }; }, false);
      router.context({
        id: 'chatstick',
        blocks: [
          { id: 'chatstick.catalog', layer: 'stable', after: ['persona.profile', 'memory.core', 'delegation.guide'], label: '聊天表情目录', worker: 'optional' },
          { id: 'chatstick.targets', layer: 'turn', after: ['core.presentation'], label: '聊天表情渠道', worker: 'optional' },
        ],
        prepare: ({ conversation, source, replyStyles }) => {
          if (!eligible(source)) return emptyContext;
          const policy = channels(conversation.personaId);
          const allowed = replyStyles?.filter((target) => target.supportsImages && policy[target.id] !== false) ?? [];
          if (!allowed.length) return emptyContext;
          const available = entries(conversation.personaId).filter((entry) => entry.enabled);
          if (!available.length) return emptyContext;
          const preference = store.document<Persona>('personas', conversation.personaId)?.expression?.stickers;
          return { 'chatstick.catalog': [{ text: [
            '聊天表情可选。' + (preference ||
              '轻松交流时，贴合语境才选一张，避免连着重复；正式工作、审批和故障说明用文字。'),
            '最多从以下目录选一张，只在回复末尾另起一行写 [ECHO_STICKER:编号]，由应用呈现。',
            ...available.map(({ key, label, meaning }) => JSON.stringify({ key, label, meaning })),
          ].join('\n') }], 'chatstick.targets': [{
            text: '本轮可使用聊天表情的投递目标只有 ' + allowed.map((target) => target.id).join('、') + '。',
          }] };
        },
      }, ctx.capabilities);
      ctx.dispose(router.registerReplyDecorator((run, text, target) => {
        const match = marker.exec(text.trimEnd());
        if (!match) return { text: text.replace(markerLines, '') };
        const body = text.slice(0, match.index).trimEnd();
        if (/^\s*\[ECHO_STICKER:[^\r\n]*\]\s*$/m.test(body))
          return { text: body.replace(markerLines, '').trimEnd() };
        const personaId = store.conversation(run.conversationId)?.personaId;
        if (!body || !personaId || !target?.supportsImages || !eligible(run.source) ||
            !characterEnabled(store, personaId, 'chatstick') || channels(personaId)[target.id] === false)
          return { text: body };
        const entry = store.document<Entry>('chatstick', rowId(personaId, match[1]));
        return {
          text: body,
          ...(entry?.enabled && entry.image.hash !== latestImage(run.conversationId, target.id) ? { image: entry.image } : {}),
        };
      }));
    },
  };
}
