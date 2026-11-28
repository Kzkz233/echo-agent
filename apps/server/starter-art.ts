import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { internal } from '../../packages/kernel/registry.ts';
import type { Application } from './application.ts';
import legacy from './starter-legacy.json' with { type: 'json' };

export type StarterId = keyof typeof legacy;
export const starterStickers = [["hello","招呼","见面、回来或轻松地接上对话"],["listen","在听","想把话讲完，表示认真听着"],["thanks","谢谢","收到对方的体谅、帮助或分享"],["celebrate","替你高兴","分享喜悦，庆祝真实发生的小进展"],["thinking","一起琢磨","暂未确定，愿意一起想想"],["surprise","意外","出乎意料的轻松消息"],["sorry","抱歉","自己会错意或造成小麻烦时诚恳致歉"],["comfort","陪着你","安慰、体谅、支持，不催促对方"]] as const;
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function starterRoleId(app: Application, id: StarterId) {
  const older = 'example-' + legacy[id].legacyId;
  const pkg=app.store.document<any>('characters', older)?.package?.id;
  return pkg==='echo-starter-'+legacy[id].legacyId || pkg==='echo-starter-'+id ? older : 'example-'+id;
}
export async function portrait(folder:string) {
  return 'data:image/webp;base64,'+(await readFile(join(folder,'portrait.webp'))).toString('base64');
}
export async function starterPet(app:Application,folder:string,name:string,signal:AbortSignal){
  const result:any=await app.registry.call('avatar.import',{source:folder,name,fps:1,
    requestId:'starter-pet-'+hash(Buffer.concat(await Promise.all(['manifest.json','atlas.png'].map(f=>readFile(join(folder,f)))))).slice(0,32)},internal,signal);
  return result.directory as string;
}
export async function installStickers(app:Application,id:StarterId,roleId:string,folder:string,signal:AbortSignal,upgrade=false) {
  const existing:any[]=await app.registry.call('chatstick.list',{personaId:roleId},internal,signal);
  const oldHashes:Record<string,string>=legacy[id].stickers;
  for(const [key,label,meaning] of starterStickers){
    const saved=existing.find(s=>s.key===key);
    if(saved && saved.image.hash!==oldHashes[key])continue;
    if(upgrade && !saved && key in oldHashes)continue; // Respect explicitly removed original stickers.
    const oldLabel=({hello:'招呼',thinking:'想一想',celebrate:'开心'} as Record<string,string>)[key];
    const oldMeaning=({hello:'轻松打招呼或表示收到',thinking:'好奇、认真思考或一起琢磨',celebrate:'恰当的小小庆祝'} as Record<string,string>)[key];
    await app.registry.call('chatstick.save',{personaId:roleId,key,label:saved && saved.label!==oldLabel?saved.label:label,
      meaning:saved && saved.meaning!==oldMeaning?saved.meaning:meaning,enabled:saved?.enabled??true,
      data:(await readFile(join(folder,'stickers',key+'.png'))).toString('base64'),replace:Boolean(saved)},internal,signal);
  }
}
export async function originalPet(app:Application,id:StarterId,directory:string){
  if(!directory || !app.store.documents<any>('avatar-assets').some(a=>a.directory===directory))return false;
  const bytes=await readFile(join(directory,'atlas.png')).catch(()=>undefined);
  return !!bytes && hash(bytes)===legacy[id].atlas;
}

/** Keep the original managed files addressable by historical attachments and rollback. */
export async function retireStarterPets(app:Application) {
  const inUse=new Set([app.store.get<any>('avatar.config',{}),...app.store.documents<any>('avatar-profiles')].map(p=>p.assetDirectory));
  for(const asset of app.store.documents<any>('avatar-assets')){
    if(asset.retired || inUse.has(asset.directory))continue;
    const entry=Object.entries(legacy).find(([,v])=>v.legacyName===asset.name);
    if(entry && await originalPet(app,entry[0] as StarterId,asset.directory))
      app.store.put('avatar-assets',asset.id,{...asset,retired:true});
  }
}
