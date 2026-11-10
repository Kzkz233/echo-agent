import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { characterEnabled, characterSettings } from '../../packages/kernel/characters.ts';
import type { Caller } from '../../packages/kernel/registry.ts';
import type { Store } from '../../packages/kernel/store.ts';

export const mailGrants = z.object({ accountIds: z.array(id).max(100).optional() });

export function mailAccounts(store: Store, personaId?: string) {
  const accounts = store.documents<{ id: string; name: string; personaId?: string }>(
    'mail-accounts',
  );
  if (!personaId) return accounts;
  const grants = mailGrants.parse(characterSettings(store, personaId, 'mail', {}));
  return accounts.filter(
    (account) => grants.accountIds?.includes(account.id) ?? account.personaId === personaId,
  );
}

export function mailCallerAccounts(store: Store, caller: Caller) {
  if (caller.kind !== 'mcp') return mailAccounts(store);
  if (!caller.personaId || !characterEnabled(store, caller.personaId, 'mail')) return [];
  return mailAccounts(store, caller.personaId);
}

export function requireMailbox(store: Store, caller: Caller, accountId?: string) {
  if (caller.kind !== 'mcp') return;
  invariant(
    mailCallerAccounts(store, caller).some((account) => account.id === accountId),
    'mail_scope',
    '此角色未获得该邮箱的访问授权。',
  );
}
