import { t } from './i18n.ts';
export function libraryLabel(vault: any, plugins: any[]) {
  const registration = vault.registeredBy ?? vault.owner ?? 'manual';
  const storedName = vault.owner === 'persona' && vault.name === 'Persona Library' ? 'Companion Library' : vault.name;
  const name = vault.owner || storedName === 'Personal Knowledge' ? t(storedName) : storedName,
    origin =
      registration !== 'manual'
        ? t(plugins.find((p) => p.id === registration)?.name ?? registration)
        : t('手动登记');
  return `${name} (${origin})`;
}
