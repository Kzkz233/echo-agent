import{seedProfile,seedRoutes}from'../scripts/inference-fixture.ts';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Application } from '../apps/server/application.ts';
import {
  profileSchema,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
} from '../packages/contracts/index.ts';
export const project = resolve(import.meta.dirname, '..');
async function cleanup(path: string) {
  const base = join(tmpdir(), 'EchoTests');
  if (!resolve(path).startsWith(resolve(base) + sep)) throw Error('Unsafe cleanup path');
  await rm(path+'-workspaces', { recursive: true, force: true });
  await rm(path, { recursive: true, force: true });
}
export async function temporary(t: TestContext, autoCleanup = true) {
  const base = join(tmpdir(), 'EchoTests');
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, 'case-'));
  if (autoCleanup) t.after(() => cleanup(path));
  return path;
}
export async function setup(t: TestContext, plugins?: string[]) {
  const runtime = await temporary(t, false);
  const app = await Application.create({ runtime, project, plugins });
  t.after(async () => {
    await app.close();
    await cleanup(runtime);
  });
  const profile = profileSchema.parse({
    id: 'test',
    name: 'Test',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'synthetic',
    vision: true,
  });
  seedProfile(app,profile);
  seedRoutes(app, {
    chat: 'test',
    vision: 'test',
    query: 'test',
    review: 'test',
    embedding: 'test',
  });
  app.store.set('memory.config', { planner: false });
  return app;
}
export function conversation(app: Application, options: Record<string, unknown> = {}) {
  const c = {
    id: randomUUID(),
    title: 'Synthetic chat',
    personaId: 'companion',
    injection: false,
    review: false,
    createdAt: new Date().toISOString(),
    ...options,
  };
  app.store.saveConversation(c as any);
  return c;
}
export class FakeBackend implements Backend {
  kind = 'api' as const;
  calls: GenerateRequest[] = [];
  seeds: any[] = [];
  archived: string[] = [];
  responder: (r: GenerateRequest) => Promise<GenerateResult> = async () => ({ text: '合成回复' });
  async generate(request: GenerateRequest) {
    this.calls.push(request);
    return this.responder(request);
  }
  async createSession(_profile: any, history: any[]) {
    this.seeds.push(history);
    return 'session-' + this.seeds.length;
  }
  async archiveSession(_profile: any, sessionId: string) {
    this.archived.push(sessionId);
  }
}
export async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
