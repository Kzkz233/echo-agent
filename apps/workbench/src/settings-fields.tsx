import type { ReactNode } from 'react';
import { t } from './i18n.ts';

/** Presentation only. The owner keeps all values, including collapsed overrides. */
export function SettingsFields<F>({ fields, render, advanced, title = '高级设置' }: {
  fields: readonly F[]; render: (field: F) => ReactNode; advanced: (field: F) => boolean; title?: string;
}) {
  const basic = fields.filter(field => !advanced(field));
  const more = fields.filter(advanced);
  return <>
    {basic.length > 0 && <div className="form-grid">{basic.map(render)}</div>}
    {more.length > 0 && <details className="setup-capability">
      <summary>{t(title)}</summary>
      <div className="form-grid">{more.map(render)}</div>
    </details>}
  </>;
}
