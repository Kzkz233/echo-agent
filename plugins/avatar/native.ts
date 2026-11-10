import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StdioRpc } from '../../packages/backends/rpc.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Events } from '../../packages/kernel/events.ts';
import { z } from 'zod';
import { displayAvatar } from './profiles.ts';
import { avatarStateClip } from '../../packages/contracts/avatar.ts';
export type AvatarRenderer = { kind: 'frames'; directory: string; issue?: string };
export class NativeAvatar {
  private client?: StdioRpc;
  private generation = 0;
  private pumping = false;
  private queue: Promise<any> = Promise.resolve();
  private closed = true;
  private instance = '';
  private configured = '';
  private activeConversation = '';
  private working?: boolean;
  private activitySignature = '';
  private activityRevision = 0;
  private homeOffset?: number;
  private activityTimer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
    readonly project: string,
    readonly helper: string,
    readonly renderer?: () => Promise<AvatarRenderer>,
    readonly replyImage?: (value: unknown) => Promise<string | undefined> | undefined,
    readonly states?: () => Promise<any[]>,
    readonly personaId?: string,
    readonly slot = 0,
  ) {}
  private config() {
    return displayAvatar(this.store, this.personaId);
  }
  private issueKey() {
    return this.personaId ? 'avatar.issue.' + this.personaId : 'avatar.issue';
  }
  async status() {
    let state: any = {
      renderer: 'win32',
      running: false,
      visible: false,
      available: existsSync(join(dirname(this.helper), 'echo-avatar.exe')),
    };
    if (this.client)
      try {
        state = { running: true, ...(await this.client.call('avatar.status', {})) };
      } catch {
        /* A concurrent native exit is represented as unavailable during recovery. */
      }
    return { ...state, personaId: this.personaId, issue: this.store.get(this.issueKey(), null) };
  }
  start() {
    this.closed = false;
    return this.update();
  }
  async shutdown() {
    this.closed = true;
    clearTimeout(this.activityTimer);
    await this.stop();
    await this.queue.catch(() => {});
    await this.stop();
  }
  update() {
    if (this.closed) return Promise.resolve();
    const work = this.queue.then(() => this.configure());
    this.queue = work.catch((e) => {
      if (!this.closed)
        this.store.set(this.issueKey(), {
          message: e instanceof Error ? e.message : '原生窗口未就绪',
          at: new Date().toISOString(),
        });
    });
    return work;
  }
  private async configure() {
    if (this.closed) return;
    const cfg = this.config();
    if (!cfg.enabled) {
      await this.stop();
      return;
    }
    const binary = join(dirname(this.helper), 'echo-avatar.exe');
    if (!existsSync(binary)) throw Error('原生桌宠程序未构建');
    if (!this.client) {
      this.instance = randomUUID();
      const client = new StdioRpc(binary, [], this.project, undefined, async (method, params) => {
        if (method !== 'avatar.reply' || this.closed || this.client !== client)
          throw Error('原生请求已失效');
        const p = z
          .object({
            conversationId: z.string().min(1),
            text: z.string().trim().min(1).max(100000),
            requestId: z.string().min(1).max(160),
          })
          .parse(params);
        const shown = this.config();
        if (
          !shown.enabled ||
          this.store.conversation(p.conversationId)?.personaId !== shown.personaId
        )
          throw Error('回复会话不属于当前桌宠角色');
        return this.router.enqueue({ ...p, bubble: true });
      });
      this.client = client;
      client.subscribe((method) => {
        if (this.client !== client) return;
        if (method === 'echo/disconnected') {
          this.client = undefined;
          this.generation++;
          this.store.set(this.issueKey(), {
            message: '原生桌宠已退出；正在尝试恢复窗口，不重放已领取气泡',
            at: new Date().toISOString(),
          });
          this.events.emit('avatar.issue', {
            personaId: this.personaId,
            message: '原生桌宠已退出；未重放已领取的气泡',
          });
        }
        if (method === 'avatar.dismissed') void this.pump().catch(() => {});
      });
    }
    let directory = cfg.assetDirectory?.trim()
      ? resolve(cfg.assetDirectory)
      : existsSync(join(this.project, 'dist/web/assets/cute-girl/manifest.json'))
        ? join(this.project, 'dist/web/assets/cute-girl')
        : join(this.project, 'apps/workbench/public/assets/cute-girl');
    const selected = await this.renderer?.();
    if (this.closed || !this.client) return;
    if (selected) directory = selected.directory;
    const target =
      (this.store.conversation(cfg.conversationId)?.personaId === cfg.personaId &&
        cfg.conversationId) ||
      this.store.conversations().find((c) => c.personaId === cfg.personaId)?.id ||
      '';
    const params = {
      language: this.store.get<any>('preferences', {}).language ?? 'zh-CN',
      directory,
      animationClips: cfg.animationClips,
      stateRules: ((await this.states?.()) ?? []).map((state) => ({
        id: state.id,
        priority: cfg.stateRules[state.id]?.priority ?? state.priority,
        clip: avatarStateClip(state, { ...cfg, renderer: selected?.kind ?? 'frames' }),
        fallback: state.fallback,
      })),
      roam: cfg.roam,
      renderer: selected?.kind ?? 'frames',
      instanceId: this.instance,
      slot: this.slot,
      homeOffset: this.homeOffset,
      scale: cfg.scale ?? 1,
      fps: cfg.fps ?? 10,
      corner: cfg.corner ?? 'right',
      conversationId: target,
      conversationTitle: this.store.conversation(target)?.title ?? 'Choose a chat in Echo',
    };
    const signature = JSON.stringify({ ...params, homeOffset: undefined });
    if (signature !== this.configured) {
      await this.client.call('avatar.configure', params);
      this.configured = signature;
      this.working = undefined;
      this.activitySignature = '';
    }
    this.activeConversation = target;
    await this.refreshActivity(target);
    this.store.set(
      this.issueKey(),
      selected?.issue ? { message: selected.issue, at: new Date().toISOString() } : null,
    );
    void this.pump().catch(() => {});
  }
  async refreshActivity(conversationId?: string) {
    const revision = ++this.activityRevision;
    const client = this.client;
    if (!client || this.closed || (conversationId && this.activeConversation !== conversationId))
      return;
    const states = (await this.states?.()) ?? [];
    if (client !== this.client || this.closed || revision !== this.activityRevision) return;
    const active = states.filter((s) => s.instances.length).map((s) => s.id);
    const working = active.includes('avatar.working') || active.includes('delegation.working');
    clearTimeout(this.activityTimer);
    if (active.length) {
      // Re-read live sources before leases expire; no idle polling or resident worker.
      this.activityTimer = setTimeout(
        () => void this.refreshActivity().catch(() => {}),
        Math.max(
          50,
          Math.min(
            60000,
            ...states.flatMap((s) => s.instances.map((i: any) => i.expiresAt - Date.now())),
          ),
        ),
      );
      this.activityTimer.unref();
    }
    const signature = JSON.stringify(active.sort());
    if (this.activitySignature === signature && this.working === working) return;
    this.working = working;
    this.activitySignature = signature;
    try {
      await client.call('avatar.activity', { working, states: active });
    } catch (error) {
      if (this.client === client && this.working === working) this.working = undefined;
      throw error;
    }
  }
  async dock() {
    await this.client?.call('avatar.dock', {});
  }
  async arrange(homeOffset: number) {
    if (!this.client || this.closed || homeOffset === this.homeOffset) return;
    const client = this.client;
    await client.call('avatar.layout', { homeOffset });
    if (!this.closed && this.client === client) this.homeOffset = homeOffset;
  }
  async release() {
    await this.client?.call('avatar.release', {});
  }
  async pump() {
    if (this.pumping || !this.client) return;
    this.pumping = true;
    const client = this.client,
      generation = this.generation;
    try {
      if ((await client.call('avatar.status', {})).bubbleVisible) return;
      while (this.client === client && generation === this.generation) {
        const profile = this.config();
        const next = this.store
          .pendingDeliveries()
          .filter(
            (delivery) =>
              this.store.conversation(delivery.conversationId)?.personaId === profile.personaId,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) return;
        if (Date.now() - Date.parse(next.createdAt) > 600000) {
          this.store.saveReceipt(next.id, { ...next, state: 'expired' });
          continue;
        }
        const message = this.store.message(next.messageId);
        const image =
          message && (message.source === 'chat' || message.source === 'care')
            ? await this.replyImage?.(message.meta.image)
            : undefined;
        const current = this.config();
        if (
          this.client !== client ||
          this.generation !== generation ||
          !current.enabled ||
          current.personaId !== profile.personaId
        )
          return;
        if (this.store.receipt(next.id)?.state !== 'pending') continue;
        const claimId = randomUUID();
        this.store.saveReceipt(next.id, {
          ...next,
          state: 'claimed',
          claimId,
          claimedAt: new Date().toISOString(),
        });
        try {
          const result = await client.call('avatar.show', {
            text: next.text,
            conversationId: next.conversationId,
            conversationTitle: this.store.conversation(next.conversationId)?.title ?? 'Echo',
            seconds: current.bubbleSeconds,
            ...(image ? { image } : {}),
          });
          if (result.shown) {
            this.store.saveReceipt(next.id, {
              ...next,
              state: 'shown',
              claimId,
              acknowledgedAt: new Date().toISOString(),
              renderer: 'win32',
              ...(result.imageShown ? { imageShown: true } : {}),
            });
            this.events.emit('avatar.shown', { id: next.id });
          }
          return;
        } catch {
          this.store.saveReceipt(next.id, { ...next, state: 'unknown', claimId });
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  async stop() {
    clearTimeout(this.activityTimer);
    this.activityRevision++;
    this.generation++;
    const client = this.client;
    this.client = undefined;
    this.configured = '';
    this.activeConversation = '';
    this.working = undefined;
    await client?.close();
  }
}
