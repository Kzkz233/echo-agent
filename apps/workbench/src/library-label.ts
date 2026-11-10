import { t } from './i18n.ts';
export function libraryLabel(vault: any, plugins: any[]) {
  const registration = vault.registeredBy ?? vault.owner ?? 'manual';
  const name = vault.owner || vault.name==='Personal Knowledge' ? t(vault.name) : vault.name,
    origin =
      registration !== 'manual'
        ? t(plugins.find((p) => p.id === registration)?.name ?? registration)
        : t('手动登记');
  return `${name} (${origin})`;
}
