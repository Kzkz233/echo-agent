import { characterFeature, characterSettings } from '../../packages/kernel/characters.ts';
import manifest from './echo-plugin.json' with { type: 'json' };
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Events } from '../../packages/kernel/events.ts';
import { id, invariant } from '../../packages/contracts/index.ts';
import { operations } from '../shared.ts';
import { ownPersona } from '../../packages/kernel/resource-access.ts';
const settings = z.object({
  inject: z.boolean().default(true),
  maxNotes: z.number().int().min(1).max(20).default(6),
  maxChars: z.number().int().min(300).max(10000).default(2400),
});
const note = z
  .object({
    id: id.optional(),
    personaId: id,
    title: z.string().trim().min(1).max(160),
    text: z.string().trim().min(1).max(3000),
    focus: z.string().max(2000).default(''),
    evidence: z.string().max(3000).default(''),
    sources: z.array(z.string()).max(100).default([]),
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type Reflection = z.infer<typeof note> & { id: string; updatedAt: string };
export class Reflections {
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
  ) {}
  config(personaId?: string) {
    return settings.parse(
      characterSettings(
        this.store,
        personaId,
        'reflections',
        this.store.get('reflections.config', {}),
      ),
    );
  }
  list(personaId?: string) {
    return this.store
      .documents<Reflection>('reflections')
      .filter((n) => !personaId || n.personaId === personaId);
  }
  private snapshot(row: Reflection, reason: string) {
    this.store.put('reflections-history', row.id + '.' + row.version + '.' + reason, {
      ...row,
      reason,
    });
  }
  private migrate() {
    if (this.store.get('reflections.format', 0) >= 2) return;
    this.store.transaction(() => {
      for (const old of this.store.documents<any>('reflections')) {
        this.snapshot(old, 'format-1');
        if (old.status && old.status !== 'active') {
          this.store.remove('reflections', old.id);
          continue;
        }
        const { status, kind, realm, priority, ...rest } = old;
        this.store.put('reflections', old.id, rest);
      }
      this.store.set('reflections.format', 2);
    });
  }
  save(raw: unknown) {
    const v = note.parse(raw),
      key = v.id ?? randomUUID(),
      old = this.store.document<Reflection>('reflections', key);
    invariant(this.store.document('personas', v.personaId), 'missing_persona', '角色不存在。');
    invariant(
      (old?.version ?? 0) === v.version,
      'revision_conflict',
      '这条关注已变化，请重新读取。',
    );
    invariant(!old || old.personaId === v.personaId, 'persona_mismatch', '不能改变关注所属角色。');
    const row = { ...v, id: key, version: v.version + 1, updatedAt: new Date().toISOString() };
    if (old) this.snapshot(old, 'updated');
    this.store.put('reflections', key, row);
    this.events.emit('reflections.updated', { personaId: v.personaId, id: key });
    return row;
  }
  forget(personaId: string, key: string, version: number) {
    const old = this.store.document<Reflection>('reflections', key);
    invariant(
      old && old.personaId === personaId && old.version === version,
      'revision_conflict',
      '这条关注已变化，请重新读取。',
    );
    this.snapshot(old, 'faded');
    this.store.remove('reflections', key);
    this.events.emit('reflections.updated', { personaId, id: key });
    return { removed: true };
  }
  preview(personaId: string) {
    const c = this.config(personaId),
      selected: Reflection[] = [];
    const candidates = this.list(personaId).sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    const header =
      '角色近期在意的事（当前关心和想接续的话题，不是待办清单；与眼前交流有关时自然带入，不必逐项提起）：\n';
    const block = (n: Reflection) =>
      `- ${n.title}：${n.text}${n.focus ? '\n  想接着关注：' + n.focus : ''}`;
    let chars = header.length;
    for (const n of candidates) {
      const size = block(n).length + 1;
      if (selected.length >= c.maxNotes || chars + size > c.maxChars) continue;
      selected.push(n);
      chars += size;
    }
    const text = selected.length
      ? header +
        selected
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(block)
          .join('\n')
      : '';
    return {
      text,
      notes: selected,
      chars: text.length,
      omitted: candidates.length - selected.length,
    };
  }
  apply(personaId: string, jobId: string, proposals: any[]) {
    return this.store.transaction(() => {
      // Every packet reads the same frozen snapshot. Revisions made within this
      // atomic batch must not invalidate later proposals from that snapshot.
      const initialVersions = new Map(this.list(personaId).map((row) => [row.id, row.version]));
      let applied = 0;
      for (const p of proposals) {
        const receipt =
          'reflection-review.' +
          createHash('sha256')
            .update(JSON.stringify([personaId, jobId, p]))
            .digest('hex');
        if (this.store.receipt(receipt)) continue;
        const attributes = z
          .object({
            focus: z.string().max(2000).optional(),
          })
          .strict()
          .parse(p.attributes ?? {});
        const operation = z.enum(['add', 'update', 'forget']).parse(p.operation ?? 'add');
        const old = p.subjectId
          ? this.store.document<Reflection>('reflections', p.subjectId)
          : undefined;
        if (operation !== 'add')
          invariant(
            old && old.personaId === personaId && initialVersions.get(old.id) === p.expectedVersion,
            'revision_conflict',
            '整理期间关注已变化，未覆盖当前内容。',
          );
        if (operation === 'forget') {
          this.forget(personaId, old!.id, old!.version);
          this.store.saveReceipt(receipt, { state: 'succeeded', id: old!.id, removed: true });
          applied++;
          continue;
        }
        if (operation === 'add') {
          const same = this.list(personaId).find(
            (n) => n.title.trim() === p.title.trim() && n.text.trim() === p.text.trim(),
          );
          if (same) {
            this.store.saveReceipt(receipt, { state: 'unchanged', id: same.id });
            continue;
          }
        }
        const row = this.save({
          id:
            old?.id ?? 'review-' + createHash('sha256').update(receipt).digest('hex').slice(0, 24),
          personaId,
          title: p.title,
          text: p.text,
          focus: attributes.focus ?? old?.focus ?? '',
          evidence: old?.evidence ?? '',
          sources: [...new Set([...(old?.sources ?? []), ...p.sources])],
          version: old?.version ?? 0,
        });
        this.store.saveReceipt(receipt, { state: 'succeeded', id: row.id, version: row.version });
        applied++;
      }
      return { applied };
    });
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      character: characterFeature(
        this.store,
        'reflections',
        settings,
        defineManifest(manifest).settings,
        [],
      ),
      config: { schema: settings },
      activate: (ctx) => {
        this.migrate();
        const op = operations(ctx, 'reflections');
        op(
          'list',
          '读取角色近期在意的事',
          z.object({ personaId: id.optional() }),
          'reflections.read',
          (v, _s, caller) => this.list(ownPersona(caller, v.personaId)),
        );
        op('save', '记录或修订角色当前关注', note, 'reflections.write', (v, _s, caller) => {
          ownPersona(caller, v.personaId);
          return this.save(v);
        });
        op(
          'forget',
          '让一条关注淡出当前背景',
          z.object({ personaId: id, id, expectedVersion: z.number().int().min(1) }),
          'reflections.write',
          (v, _s, caller) => {
            ownPersona(caller, v.personaId);
            return this.forget(v.personaId, v.id, v.expectedVersion);
          },
        );
        op(
          'preview',
          '预览当前关注注入',
          z.object({ personaId: id }),
          'reflections.read',
          (v, _s, caller) => this.preview(ownPersona(caller, v.personaId)!),
        );
        this.router.context(
          {
            id: 'reflections',
            blocks: [{ id: 'reflections.current', layer: 'turn', after: ['memory.recall'] }],
            prepare: ({ conversation, source }) => ({
              'reflections.current':
                source !== 'care' && this.config(conversation.personaId).inject
                  ? [{ text: this.preview(conversation.personaId).text }]
                  : [],
            }),
          },
          ctx.capabilities,
        );
        ctx.capabilities.provide(
          'care.context@1',
          'reflections.current',
          'Character Concerns',
          (v) => ({ text: this.preview(v.personaId).text }),
        );
        ctx.capabilities.provide(
          'review.targets@1',
          'reflections.state',
          'Character Concerns',
          (v) =>
            v.action === 'describe'
              ? {
                  context: JSON.stringify(
                    this.list(v.personaId).map((n) => ({
                      id: n.id,
                      version: n.version,
                      title: n.title,
                      text: n.text,
                      focus: n.focus,
                    })),
                  ),
                  instructions:
                    '只维护角色近期真正惦记、想主动关心或以后接着聊的事，不收集一切主观看法，不把它们写成待办或要求使用者完成的任务。长期感受、关系体验和稳定偏好仍可作为记忆，不因主观就放到这里。少量保留，重复内容修订原条目；没有相关新经历可以不改，也不因一天没提起就删除。已不再牵挂或自然淡去时使用 forget，这不意味着问题已解决。operation 仅可为 add/update/forget；update/forget 带 subjectId、expectedVersion，引用现有条目；attributes 只可含 focus（之后想自然接续的关注方向）。新增用 add，不填 subjectId。',
                }
              : this.apply(v.personaId, v.jobId, v.proposals),
        );
      },
    };
  }
}
