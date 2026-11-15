import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceSnapshot, colorContrast } from '../packages/contracts/appearance.ts';
import { preferencesSchema } from '../packages/contracts/index.ts';
import { setup } from './helpers.ts';

test('legacy appearance preferences retain their values and leave roles and permissions intact', async (t) => {
  const app = await setup(t),
    caller = { kind: 'ui' as const, permissions: new Set(['*']) };
  const before = app.store.documents('personas');
  const legacy = { language: 'en', accent: '#168477' };
  assert.deepEqual(preferencesSchema.parse(legacy), legacy);
  await app.registry.call(
    'preferences.save',
    { ...legacy, theme: 'dark', chatFontSize: 17, highContrast: true, reducedMotion: true },
    caller,
  );
  const boot = await app.registry.call('system.bootstrap', {}, caller);
  assert.equal(boot.preferences.theme, 'dark');
  assert.equal(boot.preferences.accent, legacy.accent);
  assert.deepEqual(app.store.documents('personas'), before);
  await assert.rejects(
    app.registry.call('preferences.save', { ...legacy, theme: 'other' }, caller),
  );
  await assert.rejects(
    app.registry.call('preferences.save', { ...legacy, chatFontSize: 100 }, caller),
  );
});

test('neutral primary actions and legible text are independent of custom accent and system appearance', () => {
  for (const dark of [false, true])
    for (const accent of ['#1f647a', '#ffffee', '#000000', '#5969c9', '#168477', '#ff0000']) {
      const { tokens: p, mode } = appearanceSnapshot({ accent }, dark);
      assert.equal(mode, dark ? 'dark' : 'light');
      for (const [text, background] of [
        ['--text', '--background'],
        ['--text', '--outgoing'],
        ['--muted', '--sidebar'],
        ['--muted', '--selected'],
        ['--faint', '--background'],
        ['--accent-text', '--panel'],
        ['--accent-text', '--surface-soft'],
      ['--accent-text', '--selected'],
      ['--accent-text', '--outgoing'],
        ['--primary-on', '--primary'],
        ['--success', '--success-soft'],
        ['--warning', '--warning-soft'],
        ['--danger', '--danger-soft'],
      ])
        assert(
          colorContrast(p[text], p[background]) >= 4.5,
          `${mode} ${accent} ${text}/${background}`,
        );
      assert.equal(p['--primary'], dark ? '#e4e9f1' : '#242931');
    }
  assert.equal(appearanceSnapshot({ theme: 'light' }, true).mode, 'light');
  assert.equal(appearanceSnapshot({ theme: 'dark' }, false).mode, 'dark');
  const normal = appearanceSnapshot(),
    high = appearanceSnapshot({ highContrast: true });
  assert.equal(high.tokens['--text'], normal.tokens['--text']);
  assert.equal(high.tokens['--line'], high.tokens['--line-strong']);
  assert.equal(appearanceSnapshot().tokens['--font-body'], '14px');
  assert.equal(appearanceSnapshot().tokens['--font-caption'], '12px');
  assert.equal(appearanceSnapshot({ uiFontSize: 16 }).tokens['--font-body'], '16px');
  assert.equal(appearanceSnapshot({ uiFontSize: 16 }).tokens['--font-caption'], '14px');
});
