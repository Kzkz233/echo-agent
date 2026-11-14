import { setTimeout as delay } from 'node:timers/promises';
type Slot = {
  key: string;
  model: string;
  busy: boolean;
  lastUsed: number;
  close: () => Promise<void>;
  timer?: NodeJS.Timeout;
};
/** Application-wide residency budget. Busy resources are never evicted. */
export class LocalModelPool {
  private slots = new Map<string, Slot>();
  private gate: Promise<unknown> = Promise.resolve();
  constructor(
    readonly config: () => { maxLoadedModels: number; idleSeconds: number } = () => ({
      maxLoadedModels: 1,
      idleSeconds: 120,
    }),
  ) {}
  private lock<T>(work: () => Promise<T>) {
    const result = this.gate.then(work, work);
    this.gate = result.catch(() => {});
    return result;
  }
  status() {
    return {
      loaded: this.slots.size,
      models: [...this.slots.values()].map(({ model, busy, lastUsed }) => ({
        model,
        busy,
        lastUsed,
      })),
    };
  }
  forget(key: string) {
    const s = this.slots.get(key);
    if (s) clearTimeout(s.timer);
    this.slots.delete(key);
  }
  async release(key: string) {
    return this.lock(async () => {
      const s = this.slots.get(key);
      if (!s || s.busy) return false;
      this.forget(key);
      await s.close();
      return true;
    });
  }
  async releaseIdle() {
    let released = 0;
    for (const key of [...this.slots.keys()]) if (await this.release(key)) released++;
    return { released };
  }
  async run<T>(
    key: string,
    model: string,
    close: () => Promise<void>,
    signal: AbortSignal,
    work: () => Promise<T>,
    keepLoaded = false,
  ) {
    let slot: Slot | undefined;
    while (!slot) {
      signal.throwIfAborted();
      slot = await this.lock(async () => {
        const existing = this.slots.get(key);
        if (existing?.busy) return;
        if (existing) {
          clearTimeout(existing.timer);
          existing.busy = true;
          return existing;
        }
        while (this.slots.size >= this.config().maxLoadedModels) {
          const victim = [...this.slots.values()]
            .filter((s) => !s.busy)
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (!victim) return;
          this.forget(victim.key);
          await victim.close();
        }
        signal.throwIfAborted();
        const entry = { key, model, busy: true, lastUsed: Date.now(), close };
        this.slots.set(key, entry);
        return entry;
      });
      if (!slot) await delay(25, undefined, { signal });
    }
    try {
      signal.throwIfAborted();
      return await work();
    } catch (error) {
      this.forget(key);
      await close();
      throw error;
    } finally {
      if (this.slots.get(key) === slot) {
        slot.busy = false;
        slot.lastUsed = Date.now();
        if (!keepLoaded) {
          slot.timer = setTimeout(() => void this.release(key), this.config().idleSeconds * 1000);
          slot.timer.unref();
        }
      }
    }
  }
}
