import { createHash } from 'node:crypto';
import type { ConversationPermissions } from '../contracts/interaction.ts';

/** This module runs inside Echo's isolated DSH process, never in the user's DSH installation. */
export function dshPolicyPlugin(
  permissions: ConversationPermissions | undefined,
  workspace: string,
  ready: string,
) {
  const policy = {
    roots: [
      workspace,
      ...(permissions?.readRoots ?? []),
      ...(permissions?.writeRoots ?? []),
    ].filter(Boolean),
    writable:
      permissions?.pi.projectWrite === true || permissions?.codex.sandbox === 'workspace-write',
    writeRoots: [
      ...(permissions?.primaryReadOnly ? [] : [workspace]),
      ...(permissions?.writeRoots ?? []),
    ].filter(Boolean),
    terminal: permissions?.pi.terminal === true,
  };
  const digest = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const source = `import {realpathSync,lstatSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
export const name='echo-task-policy';
export const inject=['tools','approval'];
const policy=${JSON.stringify(policy)};
const reads=new Set(['read','read_file','read_image','ls','list_directory','glob','grep','find']);
const writes=new Set(['write','write_file','edit']);
const terminals=new Set(['pwsh','powershell','bash','terminal','shell']);
function category(name,args={}){
  if(name.startsWith('mcp__echo__'))return 'echo';
  if(name==='str_replace_editor')return args.command==='view'?'read':'write';
  if(reads.has(name))return 'read';
  if(writes.has(name))return 'write';
  if(terminals.has(name))return 'terminal';
  return 'denied';
}
function within(root,path){const part=relative(root,path);return !part||(!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+(process.platform==='win32'?'\\\\':'/')));}
function canonical(path){let current=resolve(path),suffix=[];while(!existsSync(current)){const parent=dirname(current);if(parent===current)throw Error('Missing path');suffix.unshift(relative(parent,current));current=parent;}return resolve(realpathSync(current),...suffix);}
function action(exec){
  const args=exec.arguments??{},kind=category(exec.name,args);
  if(kind==='echo')return {kind};
  if(args.sandbox_permissions||args.sandboxMode||args.sandbox_mode)throw Error('Echo task permissions cannot be escalated by a tool call.');
  if(kind==='terminal'){if(!policy.terminal)throw Error('Terminal execution is not authorized for this task.');return {kind};}
  if(kind==='denied')throw Error('This native capability is not authorized by Echo.');
  if(kind==='write'&&!policy.writable)throw Error('This task is read-only.');
  if(args.path!==undefined&&args.file_path!==undefined&&args.path!==args.file_path)throw Error('Conflicting file paths are not authorized.');
  const supplied=args.file_path??args.path;
  if(typeof supplied!=='string'||/[\\x00-\\x1f]/.test(supplied)||/^[@~]/.test(supplied))throw Error('Use an ordinary path within the authorized workspace.');
  const path=canonical(isAbsolute(supplied)?supplied:resolve(policy.roots[0]??'.',supplied));
  const roots=kind==='write'?policy.writeRoots:policy.roots;
  if(!roots.some(root=>within(canonical(root),path))||path.split(/[\\\\/]/).some(part=>part.toLowerCase()==='.git'))throw Error('Path is outside the task workspace.');
  if(existsSync(path)){const info=lstatSync(path);if(info.isFile()&&info.nlink!==1)throw Error('Hard-linked files are not authorized.');}
  return {kind,path,operation:exec.name==='edit'||args.command==='str_replace'?'edit':'write'};
}
export function apply(ctx){
  if(typeof ctx.tools.guard!=='function'||typeof ctx.tools.view!=='function')throw Error('DSH lacks the required Echo policy interfaces.');
  const check=exec=>{try{action(exec);}catch(error){return String(error.message);}};
  ctx.tools.guard(check);
  ctx.on('tools/pre-execute',async(exec,next)=>{
    let target;try{target=action(exec);}catch(error){return {kind:'deny',reason:String(error.message)};}
    const decision=await next();
    if(decision.kind==='deny'||decision.kind==='cancel')return decision;
    if(target.kind==='write')return {kind:'ask',reason:'ECHO_ACTION:'+JSON.stringify({format:'echo-dsh-action-v1',path:target.path,operation:target.operation,arguments:exec.arguments})};
    if(target.kind==='terminal')return {kind:'ask',reason:'Echo terminal command: '+JSON.stringify(exec.arguments)};
    return decision;
  });
  const masks=new WeakMap();
  ctx.on('agent/pre-step',async(input,next)=>{
    const agent=input.agent;if(!agent?.ctx?.tools?.restrict)throw Error('DSH lacks scoped tool restrictions.');
    masks.get(agent)?.();
    const allow=[...ctx.tools.view(agent).restrictableNames].filter(name=>name==='str_replace_editor'||category(name)==='echo'||category(name)==='read'||(policy.writable&&category(name)==='write')||(policy.terminal&&category(name)==='terminal'));
    masks.set(agent,agent.ctx.tools.restrict({allow}));
    return next();
  });
  writeFileSync(${JSON.stringify(ready)},JSON.stringify({digest:${JSON.stringify(digest)}}));
}
`;
  return { source, digest };
}

export function dshFileApproval(reason: string) {
  if (!reason.startsWith('ECHO_ACTION:')) return undefined;
  try {
    const value = JSON.parse(reason.slice(12));
    if (
      value.format !== 'echo-dsh-action-v1' ||
      typeof value.path !== 'string' ||
      !['write', 'edit'].includes(value.operation)
    )
      return undefined;
    return {
      path: value.path,
      operation: value.operation as 'edit' | 'write',
      detail: JSON.stringify(value.arguments),
    };
  } catch {
    return undefined;
  }
}
