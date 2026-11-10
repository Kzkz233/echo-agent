import type { Store } from '../../packages/kernel/store.ts';
import type { Events } from '../../packages/kernel/events.ts';
import { displayAvatar, displayAvatars } from './profiles.ts';
import { NativeAvatar } from './native.ts';

/** Each role owns a native instance; one slow/restarting role cannot claim another's outputs. */
export class AvatarFleet {
  private instances = new Map<string, NativeAvatar>();
  private closed = true;
  private revision = 0;
  constructor(
    readonly store: Store,
    readonly events: Events,
    readonly create: (personaId: string, slot: number) => NativeAvatar,
  ) {}
  async start() {
    this.closed = false;
    await this.update();
  }
  async update(personaId?: string) {
    if (this.closed) return;
    const revision = ++this.revision;
    const profiles = displayAvatars(this.store),
      desired = new Map(
        profiles.filter((p) => p.enabled && p.personaId).map((p) => [p.personaId!, p]),
      );
    const work: Promise<unknown>[] = [];
    for (const [id, native] of this.instances) {
      if (personaId && id !== personaId) continue;
      if (!desired.has(id)) {
        this.instances.delete(id);
        work.push(native.shutdown());
      }
    }
    for (const id of desired.keys()) {
      if (personaId && id !== personaId) continue;
      let native = this.instances.get(id),
        fresh = false;
      if (!native) {
        const occupied = new Set([...this.instances.values()].map((n) => n.slot));
        let slot = 0;
        while (occupied.has(slot)) slot++;
        native = this.create(id, slot);
        this.instances.set(id, native);
        fresh = true;
      }
      work.push(
        (fresh ? native.start() : native.update()).catch((error) => {
          if (!this.closed)
            this.events.emit('avatar.issue', {
              personaId: id,
              message: error instanceof Error ? error.message : '桌宠未就绪',
            });
        }),
      );
    }
    await Promise.allSettled(work);
    // Actual decoded widths keep different sprite canvases apart at home.
    // Native layout preserves an avatar that is already roaming or being dragged.
    let offset = 0;
    for (const native of [...this.instances.values()].sort((a,b)=>a.slot-b.slot)) {
      const state = await native.status();
      if (revision !== this.revision) return;
      if (this.closed || this.instances.get(native.personaId!) !== native || !state.visible) continue;
      await native.arrange(offset).catch(()=>{});
      offset += state.width + 20;
    }
  }
  private selected(personaId?: string) {
    return [...this.instances]
      .filter(([id]) => !personaId || id === personaId)
      .map(([, native]) => native);
  }
  async status(personaId?: string) {
    const instances = await Promise.all(this.selected(personaId).map((n) => n.status()));
    const selected =
      instances.find((n) => n.personaId === displayAvatar(this.store).personaId) ??
      instances[0] ??
      (await this.create(personaId ?? displayAvatar(this.store).personaId ?? '', 0).status());
    return {
      ...selected,
      running: instances.some((n) => n.running),
      visible: instances.some((n) => n.visible),
      instances,
      count: instances.filter((n) => n.visible).length,
    };
  }
  async refreshActivity() {
    await Promise.allSettled(this.selected().map((n) => n.refreshActivity()));
  }
  async pump(personaId?: string) {
    await Promise.allSettled(this.selected(personaId).map((n) => n.pump()));
  }
  async dock(personaId?: string) {
    await Promise.allSettled(this.selected(personaId).map((n) => n.dock()));
  }
  async release(personaId?: string) {
    await Promise.allSettled(this.selected(personaId).map((n) => n.release()));
  }
  async shutdown() {
    this.closed = true;
    this.revision++;
    const all = this.selected();
    this.instances.clear();
    await Promise.allSettled(all.map((n) => n.shutdown()));
  }
}
