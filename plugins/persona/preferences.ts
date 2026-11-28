import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, invariant, type Persona } from '../../packages/contracts/index.ts';
import { characterActive } from '../../packages/kernel/characters.ts';
import type { Deliveries } from '../../packages/kernel/delivery.ts';
import type { Caller, PluginContext } from '../../packages/kernel/registry.ts';
import { echoToolPermissions } from '../../packages/kernel/tool-access.ts';
import { characterDraft } from './character-contracts.ts';
import { editedCharacter } from './character-edits.ts';
import type { Characters } from './characters.ts';

const identityGrant = 'persona.identity.propose';
const proposal = z.object({ personaId:id, conversationId:id, before:z.string(), after:z.string().min(1).max(30000) });

export function installRolePreferences(ctx: PluginContext, characters: Characters, deliveries?: Deliveries) {
  const { store } = characters;
  function current(personaId?: string, conversationId?: string) {
    const role = personaId && store.document<{mainConversationId:string}>('characters', personaId);
    invariant(role && role.mainConversationId === conversationId && characterActive(store,personaId!), 'role_scope', '请在当前伙伴的主工作会话修改自己的偏好。');
    const persona = store.document<Persona>('personas', personaId!);
    invariant(persona,'persona_missing','伙伴不存在。');
    return persona;
  }
  ctx.registry.register({ owner:'persona', name:'persona.expression', permission:'persona.expression.write', mcp:true, roleOnly:true, mainOnly:true,
    description:'持久修改本伙伴一个渠道的表达偏好。channel 使用 role.capabilities 返回的渠道 ID，或 chat、external（QQ）、bubble。仅当用户要求以后沿用时保存。',
    input:z.object({channel:id,text:z.string().trim().max(600),expected:z.string().optional()}), output:z.unknown(),
    run: async ({channel,text,expected}, caller, signal) => {
      const persona = current(caller.personaId,caller.conversationId);
      const styles = await deliveries?.catalog(caller.conversationId!,signal) ?? [];
      const style: string | undefined = styles.find(target => target.id === channel || target.style === channel)?.style ??
        (['chat','external','bubble'].includes(channel) ? channel : undefined);
      invariant(style && !['__proto__','constructor','prototype'].includes(style), 'channel_missing', '该渠道未注册独立风格。');
      const before = characterDraft.parse({persona}), after = structuredClone(before);
      const expression = after.persona.expression ??= {};
      let previous: string | undefined;
      if (style === 'chat' || style === 'external' || style === 'bubble') {
        previous = expression[style];
        expression[style] = text;
      } else {
        const channels = expression.channels ??= {};
        previous = channels[style]; channels[style] = text;
      }
      invariant(expected === undefined || expected === (previous ?? '') || previous === text, 'revision_conflict','表达偏好已变化。');
      await characters.commit(undefined,randomUUID(),signal,{ id:persona.id,changes:editedCharacter(before,after,new Set()) },false,true);
      return {channel,style,text};
    } });
  const checkProposal = (value: z.infer<typeof proposal>) => {
    const persona = current(value.personaId,value.conversationId);
    const grants = echoToolPermissions(store,false,value,new Set([identityGrant]));
    invariant(grants.has(identityGrant), 'permission_denied', '伙伴当前未获准提议修改人设。');
    invariant(persona.prompt === value.before || persona.prompt === value.after, 'revision_conflict','人设已变化，请重新核对。');
    return persona;
  };
  ctx.registry.register({owner:'persona',name:'persona.proposeIdentity',permission:identityGrant,mcp:true,roleOnly:true,mainOnly:true,
    description:'提议修改本伙伴长期人设，用户核对原文和建议后生效。',
    input:z.object({text:z.string().trim().min(1).max(30000)}),output:z.unknown(),
    run: async ({text}, caller: Caller, signal) => {
      const persona = current(caller.personaId,caller.conversationId);
      invariant(ctx.capabilities.list('approvals.prepare@1').some(row => row.id === 'persona.identity' && row.state === 'active'),
        'approval_unavailable', '请先在扩展中启用操作审批。');
      const payload = {personaId:persona.id,conversationId:caller.conversationId!,before:persona.prompt,after:text};
      checkProposal(payload);
      const result = await ctx.registry.call('approvals.request',{executor:'persona.identity',requestId:randomUUID(),payload},caller,signal) as {id:string;state:string};
      return {id:result.id,state:result.state};
    } });
  ctx.capabilities.provide('approvals.prepare@1','persona.identity','伙伴人设变更',({payload,submittedBy})=>{
    invariant(submittedBy === 'persona','role_scope','请通过当前伙伴的人设建议入口提交。');
    const value=proposal.parse(payload), persona=checkProposal(value);
    return {personaId:value.personaId,title:'修改人设 · '+persona.name,details:[{label:'原文',value:value.before},{label:'建议内容',value:value.after}],frozen:value};
  });
  ctx.capabilities.provide('approvals.execute@1','persona.identity','应用已确认的人设',async ({frozen,approvalId},signal)=>{
    const value=proposal.parse(frozen);
    try {
      checkProposal(value);
      await characters.commit(undefined,'identity-'+approvalId,signal,{id:value.personaId,changes:{fields:[
        {path:['persona','prompt'],before:value.before,after:value.after}],tasks:[]}},false,true);
      return {state:'succeeded',receipt:{personaId:value.personaId}};
    } catch(error) { return {state:'failed',receipt:{error:String(error)}}; }
  });
  ctx.capabilities.provide('approvals.inspect@1','persona.identity','核对人设变更',({approvalId})=>{
    const receipt=store.receipt('character-setup.identity-'+approvalId);
    return {state:receipt?.state === 'completed' ? 'succeeded' : 'unknown',receipt:{applied:receipt?.state === 'completed'}};
  });
}
