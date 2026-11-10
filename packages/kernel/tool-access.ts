import type { Store } from './store.ts';
import { characterActive } from './characters.ts';

import type { AgentPrincipal } from '../contracts/index.ts';
import { conversationPermissions } from '../contracts/interaction.ts';

export type HarnessMcp = { url: string; token: string };
export type HarnessMcpProvider = (principal: AgentPrincipal) => HarnessMcp;
export const harnessMcpTokenEnv = 'ECHO_HARNESS_MCP_TOKEN';

export const defaultPermissions = [
  'system.read',
  'persona.read',
  'memory.read',
  'knowledge.read',
  'observation.read',
  'review.read',
];
export type RoleToolGrants = { toolPermissions?: string[]; independentToolGrants?: boolean };

export function roleToolGrants(store: Store, role?: RoleToolGrants) {
  const external = store.get<string[]>('mcp.permissions', defaultPermissions);
  if (role?.independentToolGrants) return role.toolPermissions ?? [];
  return (role?.toolPermissions ?? external).filter((permission) => external.includes(permission));
}

export function migrateRoleToolGrants(store: Store, active: ReadonlySet<string>) {
  if (store.get('roles.toolGrants.v1', false)) return;
  store.transaction(() => {
    const conversations = store.conversations().filter((conversation) => conversation.kind === 'worker');
    const tasks = store.documents<{ id: string; workerConversationId: string; template?: RoleToolGrants }>('delegated-tasks');
    for (const role of store.documents<RoleToolGrants & { id: string }>('characters')) {
      if (role.independentToolGrants) continue;
      const effective = roleToolGrants(store, role).filter((permission) => active.has(permission));
      const policy = store.document<Record<string, unknown>>('character-settings.delegation', role.id);
      if (policy) {
        const legacyDefault = policy.authorizationVersion === 3 ||
          (Array.isArray(policy.templates) ? policy.templates.length > 0 : Boolean(policy.profileId));
        const workerGrants = Array.isArray(policy.toolPermissions) ? policy.toolPermissions : legacyDefault ? effective : [];
        const ceiling = effective.filter((permission) => workerGrants.includes(permission));
        store.put('character-settings.delegation', role.id, { ...policy, toolPermissions: ceiling });
        for (const conversation of conversations.filter((conversation) => conversation.personaId === role.id)) {
          const permissions = conversation.permissions ?? conversationPermissions.parse({});
          const grants = ceiling.filter((permission) => !permissions.echoTools || permissions.echoTools.includes(permission));
          if (permissions.echoTools?.length !== grants.length || grants.some((permission) => !permissions.echoTools?.includes(permission)))
            store.saveConversation({ ...conversation, permissions: { ...permissions, echoTools: grants } });
          const task = tasks.find((row) => row.workerConversationId === conversation.id);
          if (task?.template?.toolPermissions?.some((permission) => !grants.includes(permission)))
            store.put('delegated-tasks', task.id, { ...task, template: {
              ...task.template, toolPermissions: task.template.toolPermissions.filter((permission) => grants.includes(permission)),
            } });
        }
      }
      store.put('characters', role.id, {
        ...role,
        independentToolGrants: true,
        toolPermissions: effective,
      });
    }
    store.set('roles.toolGrants.v1', true);
  });
}
export function echoToolPermissions(
  store: Store,
  readOnly: boolean,
  principal?: AgentPrincipal,
  characterPermissions: ReadonlySet<string> = new Set(),
) {
  const applicationPermissions = store.get<string[]>('mcp.permissions', defaultPermissions);
  let permissions: string[] = applicationPermissions;
  if (principal) {
    if (!characterActive(store, principal.personaId)) return new Set<string>();
    const conversation = store.conversation(principal.conversationId);
    if (!conversation || conversation.personaId !== principal.personaId) return new Set<string>();
    const character = store.document<RoleToolGrants>(
      'characters',
      principal.personaId,
    );
    if (!character) return new Set<string>();
    const worker = conversation.kind === 'worker' && character.independentToolGrants;
    const ceiling = worker
      ? store.document<RoleToolGrants>('character-settings.delegation', principal.personaId)?.toolPermissions ?? []
      : roleToolGrants(store, character);
    permissions = ceiling.filter((permission) => characterPermissions.has(permission));
    if (worker && !conversation.permissions?.echoTools) return new Set<string>();
    if(conversation.permissions?.echoTools)permissions=permissions.filter(permission=>conversation.permissions!.echoTools!.includes(permission));
  }
  const result = new Set(
    readOnly ? permissions.filter((permission) => permission.endsWith('.read')) : permissions,
  );
  return result;
}
