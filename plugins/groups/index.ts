import { z } from 'zod';
import { createHash } from 'node:crypto';
import manifest from './echo-plugin.json' with { type: 'json' };
import { id, invariant, type Message } from '../../packages/contracts/index.ts';
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { Router } from '../../packages/kernel/router.ts';
import type { Events } from '../../packages/kernel/events.ts';
import type { CharacterRecord } from '../persona/character-contracts.ts';
import { characterActive } from '../../packages/kernel/characters.ts';

const groupSchema = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  members: z.array(id).min(1).max(12),
  context: z.string().max(20000).default(''),
  prompt: z
    .string()
    .max(8000)
    .default(
      '在群聊中以自己的角色身份回应，结合其他成员的观点讨论。共享记录是交流资料，不替其他成员发言，不将角色私聊或私有记忆带入群聊。',
    ),
  historyWindow: z.number().int().min(5).max(100).default(40),
  revision: z.number().int().min(0).default(0),
});
type Group = z.infer<typeof groupSchema>;
type GroupTurn = {
  id: string;
  groupId: string;
  text: string;
  speakers: string[];
  done: string[];
  createdAt: string;
  state: 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  error?: string;
};
export class Groups {
  private running = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private life?: AbortSignal;
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
  ) {}
  list() {
    return this.store.documents<Group>('groups');
  }
  private transcript(id: string) {
    return this.store.documents<Message>('group-messages.' + id).sort((a, b) => a.seq - b.seq);
  }
  private post(groupId: string, message: Omit<Message, 'seq'>) {
    if (this.store.document('group-messages.' + groupId, message.id)) return;
    const seq = (this.transcript(groupId).at(-1)?.seq ?? 0) + 1;
    this.store.put('group-messages.' + groupId, message.id, { ...message, seq });
    this.events.emit('groups.updated', { groupId });
  }
  save(value: Group) {
    invariant(
      value.members.every((member) => this.store.document('personas', member)),
      'group_member',
      '请选择有效角色。',
    );
    invariant(
      new Set(value.members).size === value.members.length,
      'group_member',
      '角色不可重复。',
    );
    invariant(!this.running.has(value.id), 'group_busy', '请等待本轮群聊结束后修改成员。');
    const old = this.store.document<Group>('groups', value.id);
    invariant(
      (old?.revision ?? 0) === value.revision,
      'revision_conflict',
      '群聊已在其他窗口修改。',
    );
    const next = { ...value, revision: value.revision + 1 };
    this.store.put('groups', value.id, next);
    this.events.emit('groups.updated', { groupId: value.id });
    return next;
  }
  send(input: { groupId: string; text: string; speakers: string[]; requestId: string }) {
    const group = this.store.document<Group>('groups', input.groupId);
    invariant(group, 'group_missing', '群聊不存在。');
    invariant(
      input.speakers.length &&
        new Set(input.speakers).size === input.speakers.length &&
        input.speakers.every((member) => group.members.includes(member)),
      'group_member',
      '请选择本轮发言角色。',
    );
    const old = this.store.document<GroupTurn>('group-turns', input.requestId);
    if (old) {
      invariant(
        old.groupId === input.groupId &&
          old.text === input.text &&
          JSON.stringify(old.speakers) === JSON.stringify(input.speakers),
        'idempotency_conflict',
        '同一群聊请求的内容已变化。',
      );
      return old;
    }
    invariant(
      !this.running.has(group.id) &&
        !this.store
          .documents<GroupTurn>('group-turns')
          .some((t) => t.groupId === group.id && t.state === 'unknown'),
      'group_busy',
      '请先结束或核对上一轮群聊。',
    );
    for (const member of input.speakers) {
      invariant(characterActive(this.store, member), 'character_disabled', '所选角色已停用，请先启用或取消选择。');
      const role = this.store.document<CharacterRecord>('characters', member);
      const main =
        role?.mainConversationId ||
        this.store
          .conversations()
          .find((c) => c.personaId === member && c.kind !== 'worker' && c.kind !== 'group-member')
          ?.id;
      invariant(
        main && this.store.binding(main)?.state === 'active',
        'group_backend',
        '请先配置所选角色的主会话后端。',
      );
    }
    const turn: GroupTurn = {
      id: input.requestId,
      groupId: group.id,
      text: input.text,
      speakers: input.speakers,
      done: [],
      createdAt: new Date().toISOString(),
      state: 'running',
    };
    this.store.put('group-turns', turn.id, turn);
    this.post(group.id, {
      id: turn.id,
      conversationId: group.id,
      role: 'user',
      source: 'human',
      text: input.text,
      createdAt: turn.createdAt,
      meta: {},
    });
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.perform(group, turn, AbortSignal.any([controller.signal, this.life!])))
      .finally(() => {
        this.running.delete(group.id);
        this.events.emit('groups.updated', { groupId: group.id });
      });
    this.running.set(group.id, { controller, promise });
    void promise.catch(() => {});
    return turn;
  }
  private async perform(group: Group, turn: GroupTurn, signal: AbortSignal) {
    try {
      for (const member of turn.speakers) {
        signal.throwIfAborted();
        invariant(characterActive(this.store, member), 'character_disabled', '群聊成员已停用，本轮已停止。');
        const role = this.store.document<CharacterRecord>('characters', member);
        const main =
          role?.mainConversationId ||
          this.store
            .conversations()
            .find(
              (c) => c.personaId === member && c.kind !== 'worker' && c.kind !== 'group-member',
            )!.id;
        const binding = this.store.binding(main)!;
        const conversationId =
          'group-' +
          createHash('sha256')
            .update(group.id + ':' + member)
            .digest('hex')
            .slice(0, 28);
        if (!this.store.conversation(conversationId))
          this.store.saveConversation({
            id: conversationId,
            title:
              group.name + ' · ' + this.store.document<{ name: string }>('personas', member)!.name,
            personaId: member,
            injection: true,
            contextProviders: ['persona.context', 'delegation.context'],
            review: false,
            kind: 'group-member',
            groupId: group.id,
            permissions: this.store.conversation(main)?.permissions,
            createdAt: new Date().toISOString(),
          });
        this.store.saveConversation({
          ...this.store.conversation(conversationId)!,
          permissions: this.store.conversation(main)?.permissions,
          reasoning: this.store.conversation(main)?.reasoning,
        });
        const prior = this.store.binding(conversationId);
        invariant(
          !prior || prior.state === 'active',
          'binding_not_ready',
          '群聊角色连接结果待核对。',
        );
        await this.router.bind(conversationId, binding.profileId, signal);
        const sync = this.store.document<{ sequence: number; contextHash: string }>(
          'group-context',
          conversationId,
        );
        const contextHash = createHash('sha256')
          .update(JSON.stringify([group.name, group.context, group.members, group.prompt]))
          .digest('hex');
        const shared = this.transcript(group.id);
        const cursor = { sequence: shared.at(-1)?.seq ?? 0, contextHash };
        const transcript = shared
          .filter(
            (message) =>
              message.seq > (sync?.sequence ?? 0) &&
              !(message.role === 'assistant' && message.meta.authorPersonaId === member),
          )
          .slice(-(group.historyWindow ?? 40))
          .map((m) => ({
            speaker: m.meta.authorName ?? (m.role === 'user' ? '用户' : '系统'),
            text: m.text,
          }));
        this.store.put('group-deliveries', turn.id + '.' + member, cursor);
        const run = await this.router.send(
          {
            conversationId,
            requestId: turn.id + '.' + member,
            source: 'group',
            text: [
              ...(sync?.contextHash === contextHash
                ? []
                : [
                    group.prompt ?? groupSchema.shape.prompt.parse(undefined),
                    '群聊：' +
                      group.name +
                      '\n共同背景：' +
                      group.context +
                      '\n成员：' +
                      group.members
                        .map(
                          (id) => this.store.document<{ name: string }>('personas', id)?.name ?? id,
                        )
                        .join('、'),
                  ]),
              '本次新增的共享记录（按时间排序，窗口上限 ' +
                (group.historyWindow ?? 40) +
                ' 条）：' +
                JSON.stringify(transcript),
            ].join('\n\n'),
          },
          signal,
        );
        if (run.state !== 'succeeded') {
          const name = this.store.document<{ name: string }>('personas', member)?.name ?? member;
          turn = {
            ...turn,
            state:
              run.state === 'unknown'
                ? 'unknown'
                : run.state === 'cancelled'
                  ? 'cancelled'
                  : 'running',
            error: [turn.error, name + ' · ' + (run.error ?? '未完成回复')].filter(Boolean).join('\n'),
          };
          if (run.state === 'failed') {
            this.store.put('group-turns', turn.id, turn);
            this.events.emit('groups.updated', { groupId: group.id });
            continue;
          }
          break;
        }
        this.post(group.id, {
          id: run.id,
          conversationId: group.id,
          role: 'assistant',
          source: 'group',
          text: run.result ?? '',
          runId: run.id,
          createdAt: new Date().toISOString(),
          meta: {
            authorPersonaId: member,
            authorName: this.store.document<{ name: string }>('personas', member)!.name,
            workerConversationId: conversationId,
          },
        });
        turn = { ...turn, done: [...turn.done, member] };
        this.store.put('group-context', conversationId, cursor);
        this.store.put('group-turns', turn.id, turn);
      }
      if (turn.done.length === turn.speakers.length) turn = { ...turn, state: 'completed' };
      else if (turn.state === 'running') turn = { ...turn, state: 'failed' };
    } catch (error) {
      turn = {
        ...turn,
        state: signal.aborted ? 'cancelled' : 'failed',
        error: [turn.error, error instanceof Error ? error.message : String(error)]
          .filter(Boolean)
          .join('\n'),
      };
    }
    this.store.put('group-turns', turn.id, turn);
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      references: (id) => {
        const conversation = this.store.conversation(id);
        return conversation?.kind === 'group-member'
          ? [{ label: conversation.title, page: 'groups', role: 'channel' }]
          : [];
      },
      activate: (ctx) => {
        this.life = ctx.signal;
        ctx.dispose(this.events.subscribe(event => {
          if (event.type !== 'character.activity.changed' || event.data.enabled) return;
          for (const turn of this.store.documents<GroupTurn>('group-turns'))
            if (turn.state === 'running' && turn.speakers.includes(String(event.data.personaId))) this.running.get(turn.groupId)?.controller.abort();
        }));
        ctx.dispose(
          this.events.subscribe((event) => {
            if (event.type !== 'message.posted') return;
            const data = event.data as { conversationId: string; messageId: string };
            if (typeof data.messageId !== 'string') return;
            const chat = this.store.conversation(data.conversationId);
            const message = this.store.message(data.messageId);
            if (
              chat?.groupId &&
              message &&
              (message.source === 'notification' ||
                (message.source === 'handoff' && message.role === 'assistant'))
            )
              this.post(chat.groupId, {
                ...message,
                conversationId: chat.groupId,
                meta: {
                  ...message.meta,
                  authorPersonaId: chat.personaId,
                  authorName: this.store.document<{ name: string }>('personas', chat.personaId)
                    ?.name,
                },
              });
          }),
        );
        for (const turn of this.store.documents<GroupTurn>('group-turns'))
          if (turn.state === 'running')
            this.store.put('group-turns', turn.id, {
              ...turn,
              state: 'unknown',
              error: '群聊执行中断，请核对各角色会话。',
            });
        const op = (
          name: string,
          description: string,
          input: z.ZodType,
          run: (v: any) => unknown,
          write = false,
        ) =>
          ctx.registry.register({
            name: 'groups.' + name,
            description,
            input,
            output: z.unknown(),
            owner: 'groups',
            permission: write ? 'groups.write' : 'groups.read',
            mcp: false,
            run: (v) => run(v),
          });
        op('list', '读取群聊', z.object({}), () => this.list());
        op('save', '创建或修改群聊', groupSchema, (v) => this.save(v), true);
        op('messages', '读取群聊记录与执行状态', z.object({ id }), (v) => ({
          messages: this.transcript(v.id),
          turns: this.store.documents<GroupTurn>('group-turns').filter((t) => t.groupId === v.id),
          busy: this.running.has(v.id),
          conversations: this.store.conversations().filter(
            (c) =>
              c.kind === 'group-member' &&
              this.list()
                .find((g) => g.id === v.id)
                ?.members.some(
                  (member) =>
                    c.id ===
                    'group-' +
                      createHash('sha256')
                        .update(v.id + ':' + member)
                        .digest('hex')
                        .slice(0, 28),
                ),
          ),
        }));
        op(
          'send',
          '发送群聊消息并请所选角色依次回应',
          z.object({
            groupId: id,
            text: z.string().min(1).max(24000),
            speakers: z.array(id).min(1).max(12),
            requestId: id,
          }),
          (v) => this.send(v),
          true,
        );
        op(
          'cancel',
          '停止本轮群聊',
          z.object({ id }),
          (v) => {
            this.running.get(v.id)?.controller.abort();
            return { accepted: true };
          },
          true,
        );
        op(
          'resolve',
          '完成各角色会话核对后解除群聊中断状态',
          z.object({ id, confirmed: z.literal(true) }),
          (v) => {
            invariant(!this.running.has(v.id), 'group_busy', '群聊仍在运行。');
            const conversations = this.store
              .conversations()
              .filter((c) => c.kind === 'group-member' && c.groupId === v.id);
            invariant(
              conversations.every(
                (c) =>
                  !this.store.unresolved(c.id).length &&
                  this.store.binding(c.id)?.state !== 'unknown',
              ),
              'group_unknown',
              '请先核对群聊角色的未知运行。',
            );
            for (const turn of this.store.documents<GroupTurn>('group-turns'))
              if (turn.groupId === v.id && turn.state === 'unknown') {
                const done = new Set(turn.done);
                for (const member of turn.speakers) {
                  const run = this.store.run(turn.id + '.' + member);
                  if (run?.state !== 'succeeded') continue;
                  this.post(v.id, {
                    id: run.id,
                    conversationId: v.id,
                    role: 'assistant',
                    source: 'group',
                    text: run.result ?? '',
                    runId: run.id,
                    createdAt:
                      this.store.assistantForRun(run.id)?.createdAt ?? new Date().toISOString(),
                    meta: {
                      authorPersonaId: member,
                      authorName: this.store.document<{ name: string }>('personas', member)?.name,
                      workerConversationId: run.conversationId,
                    },
                  });
                  done.add(member);
                  const cursor = this.store.document('group-deliveries', turn.id + '.' + member);
                  if (cursor) this.store.put('group-context', run.conversationId, cursor);
                }
                this.store.put('group-turns', turn.id, {
                  ...turn,
                  done: [...done],
                  state: done.size === turn.speakers.length ? 'completed' : 'cancelled',
                  error: undefined,
                });
              }
            this.events.emit('groups.updated', { groupId: v.id });
            return { resolved: true };
          },
          true,
        );
        ctx.dispose(async () => {
          for (const w of this.running.values()) w.controller.abort();
          await Promise.allSettled([...this.running.values()].map((w) => w.promise));
          this.life = undefined;
        });
      },
    };
  }
}
