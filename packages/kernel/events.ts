import { EventEmitter } from 'node:events';
export type EchoEvent = { type: string; at: string; data: Record<string, unknown> };
export class Events {
  // Shared application bus: first-party plugins legitimately exceed Node's ten-
  // listener default. Disposers remain mandatory and lifecycle tests count them.
  private bus = new EventEmitter().setMaxListeners(100);
  emit(type: string, data: Record<string, unknown>) {
    this.bus.emit('event', { type, at: new Date().toISOString(), data } satisfies EchoEvent);
  }
  subscribe(fn: (event: EchoEvent) => void) {
    this.bus.on('event', fn);
    return () => {
      this.bus.off('event', fn);
    };
  }
  get listeners() {
    return this.bus.listenerCount('event');
  }
}
