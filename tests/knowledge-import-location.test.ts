import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, temporary, until } from './helpers.ts';

const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
test('durable import retains its chosen folder and checks request identity and library ownership', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('knowledge');
  const root = await temporary(t);
  const source = join(root, 'Manual.md');
  await writeFile(source, 'Synthetic collagen manual.');
  const input = { vaultId: 'local', source, requestId: 'manual-import', folder: 'Work/Manuals' };
  const job = await app.registry.call('knowledge.import-job', input, ui);
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  const doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.equal(doc.logicalPath, 'Work/Manuals/' + job.documentId + '.md');
  assert.equal(
    (
      await app.knowledge.search('collagen', new AbortController().signal, 10, {
        vaultId: 'local',
        folder: 'Work/Manuals',
      })
    )[0].documentId,
    job.documentId,
  );
  assert.equal((await app.registry.call('knowledge.import-job', input, ui)).id, job.id);
  await assert.rejects(
    () => app.registry.call('knowledge.import-job', { ...input, folder: 'Other' }, ui),
    /导入编号/,
  );
  await assert.rejects(
    () =>
      app.registry.call(
        'knowledge.import-job',
        { ...input, requestId: 'invalid', folder: '../Other' },
        ui,
      ),
    /目录名称/,
  );
  assert.equal(app.store.document('knowledge-jobs', 'invalid'), undefined);
  const managed = await app.files.managed('memory', 'Synthetic memory');
  await assert.rejects(
    () =>
      app.registry.call(
        'knowledge.import-job',
        { ...input, vaultId: managed.id, requestId: 'managed' },
        ui,
      ),
    /所属插件/,
  );
  assert.equal((await app.files.records(managed.id)).length, 0);

  // Reparsing from the source inspector must retain the previously chosen folder.
  const reparse = await app.registry.call(
    'knowledge.import-job',
    { vaultId: 'local', source, requestId: 'reparse' },
    ui,
  );
  await until(() => app.store.document<any>('knowledge-jobs', reparse.id)?.state === 'completed');
  assert.equal((await app.knowledge.read(job.documentId)).logicalPath, doc.logicalPath);
  assert.equal((await app.knowledge.list('local')).length, 1);
});
