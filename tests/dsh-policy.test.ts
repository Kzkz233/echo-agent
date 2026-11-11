import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporary } from './helpers.ts';
import { conversationPermissions } from '../packages/contracts/interaction.ts';
import { dshPolicyPlugin, dshFileApproval } from '../packages/backends/dsh-policy.ts';

async function install(t: any, write = false, terminal = false) {
  const root = await temporary(t),
    outside = await temporary(t);
  const ready = join(outside, 'ready.json');
  const permissions = conversationPermissions.parse({
    projectDirectory: root,
    pi: { projectWrite: write, terminal },
    codex: { sandbox: write ? 'workspace-write' : 'read-only' },
  });
  const policy = dshPolicyPlugin(permissions, root, ready);
  const entry = join(outside, 'policy.mjs');
  await writeFile(entry, policy.source);
  const plugin = await import(pathToFileURL(entry).href);
  let guard!: (exec: any) => string | undefined;
  const handlers = new Map<string, any>();
  plugin.apply({
    tools: {
      guard: (value: any) => (guard = value),
      view: () => ({
        restrictableNames: [
          'pwsh',
          'read',
          'write',
          'str_replace_editor',
          'mcp__echo__knowledge_read',
          'subagent',
        ],
      }),
    },
    on: (name: string, handler: any) => handlers.set(name, handler),
  });
  assert.equal(JSON.parse(await readFile(ready, 'utf8')).digest, policy.digest);
  return { root, outside, guard, handlers };
}

test('DSH mandatory guard denies native writes, shell, escalation and unknown capabilities for read-only tasks', async (t) => {
  const { root, outside, guard, handlers } = await install(t);
  const file = join(root, 'sample.txt');
  await writeFile(file, 'original');
  assert.equal(guard({ name: 'read', arguments: { path: file } }), undefined);
  assert.equal(
    guard({ name: 'str_replace_editor', arguments: { command: 'view', path: file } }),
    undefined,
  );
  assert.equal(guard({ name: 'mcp__echo__knowledge_read', arguments: {} }), undefined);
  for (const exec of [
    { name: 'str_replace_editor', arguments: { command: 'create', path: file } },
    { name: 'write', arguments: { path: file } },
    { name: 'pwsh', arguments: { command: 'anything' } },
    { name: 'subagent', arguments: {} },
    { name: 'read', arguments: { path: outside } },
    { name: 'read', arguments: { path: file, sandbox_permissions: 'require_escalated' } },
    { name: 'read', arguments: { path: file, file_path: outside } },
  ]) {
    assert(guard(exec));
    const decision = await handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
  }
  let mask: string[] = [];
  let disposed = 0;
  const agent = {
    ctx: {
      tools: {
        restrict: ({ allow }: any) => {
          mask = allow;
          return () => disposed++;
        },
      },
    },
  };
  await handlers.get('agent/pre-step')({ agent }, async () => {});
  assert.deepEqual(mask, ['read', 'str_replace_editor', 'mcp__echo__knowledge_read']);
  await handlers.get('agent/pre-step')({ agent }, async () => {});
  assert.equal(disposed, 1);
});

test('DSH writable scope requests structured per-file approval and cannot escape through links or metadata directories', async (t) => {
  const { root, outside, guard, handlers } = await install(t, true, true);
  const path = join(root, 'new', 'sample.txt');
  const exec = { name: 'write', arguments: { path, content: 'synthetic' } };
  assert.equal(guard(exec), undefined);
  const decision = await handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'ask');
  assert.deepEqual(dshFileApproval(decision.reason), {
    path,
    operation: 'write',
    detail: JSON.stringify(exec.arguments),
  });
  assert.equal(
    (await handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'deny' }))).kind,
    'deny',
  );
  assert.equal(
    (
      await handlers.get('tools/pre-execute')({ name: 'pwsh', arguments: {} }, async () => ({
        kind: 'allow',
      }))
    ).kind,
    'ask',
  );
  assert(guard({ name: 'write', arguments: { path: join(root, '.git', 'config') } }));
  const original = join(outside, 'original.txt');
  await writeFile(original, 'original');
  const hard = join(root, 'hard.txt');
  await link(original, hard);
  assert(guard({ name: 'edit', arguments: { path: hard } }));
  const linked = join(root, 'linked');
  await symlink(outside, linked, 'junction');
  assert(guard({ name: 'write', arguments: { path: join(linked, 'original.txt') } }));
  assert.equal(await readFile(original, 'utf8'), 'original');
  assert.equal(dshFileApproval('ECHO_ACTION:bad json'), undefined);
});
