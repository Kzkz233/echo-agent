type Alarm = { at: number; run: () => unknown | Promise<unknown> };
/** One nearest-deadline timer for all callers; no polling timer when idle. */
export class Clock {
  private alarms = new Map<string, Alarm>();
  private timer?: NodeJS.Timeout;
  private work = new Set<Promise<unknown>>();
  private closed = false;
  private paused = false;
  pause() { this.paused = true; this.arm(); }
  resume() { this.paused = false; this.arm(); }
  get pending() {
    return this.alarms.size;
  }
  get active() { return this.work.size; }
  at(key: string, at: number, run: Alarm['run']) {
    if (this.closed) return () => {};
    this.alarms.set(key, { at, run });
    this.arm();
    const alarm = this.alarms.get(key);
    return () => {
      if (this.alarms.get(key) === alarm) {
        this.alarms.delete(key);
        this.arm();
      }
    };
  }
  cancel(key: string) {
    this.alarms.delete(key);
    this.arm();
  }
  private arm() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.alarms.size || this.closed || this.paused) return;
    const at = Math.min(...[...this.alarms.values()].map((a) => a.at));
    this.timer = setTimeout(() => this.fire(), Math.max(0, Math.min(2147483647, at - Date.now())));
    this.timer.unref();
  }
  private fire() {
    const now = Date.now();
    for (const [key, a] of this.alarms)
      if (a.at <= now) {
        this.alarms.delete(key);
        const task = Promise.resolve().then(a.run);
        this.work.add(task);
        void task.catch(() => {}).finally(() => this.work.delete(task));
      }
    this.arm();
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.alarms.clear();
    await Promise.allSettled(this.work);
  }
}
