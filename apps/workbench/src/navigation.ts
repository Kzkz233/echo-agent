export type View = { id: string; text: string };
export type Section = { id: string; text: string; icon: string; group: string; views: View[] };
export const sections: Section[] = [
  {
    id: 'chat',
    text: '会话工作台',
    icon: 'chat',
    group: '交流与陪伴',
    views: [{ id: 'chat', text: '会话工作台' }],
  },
  {
    id: 'personas',
    text: '角色',
    icon: 'personas',
    group: '交流与陪伴',
    views: [
      { id: 'personas', text: '角色列表' },
      { id: 'character', text: '聊天' },
      { id: 'character-session', text: '后台工作会话' },
      { id: 'character-wizard', text: '角色配置' },
      { id: 'persona-settings', text: '角色设定' },
      { id: 'memory', text: '角色记忆' },
      { id: 'reflections', text: '角色关切' },
      { id: 'avatar', text: '桌宠展示' },
      { id: 'chatstick', text: '聊天表情' },
      { id: 'delegation', text: '任务委派' },
      { id: 'channels', text: '会话通道' },
    ],
  },
  {
    id: 'groups',
    text: '群聊',
    icon: 'chat',
    group: '交流与陪伴',
    views: [{ id: 'groups', text: '群聊' }],
  },
  {
    id: 'automation',
    text: '自动化任务',
    icon: 'scheduler',
    group: '交流与陪伴',
    views: [
      { id: 'automation', text: '任务总览' },
      { id: 'care', text: '主动交流' },
      { id: 'observation', text: '实时观察' },
      { id: 'review', text: '记忆整理' },
      { id: 'scheduler', text: '调度记录' },
    ],
  },
  {
    id: 'knowledge',
    text: '知识库',
    icon: 'knowledge',
    group: '资料与事务',
    views: [
      { id: 'knowledge', text: '个人知识库' },
    ],
  },
  {
    id: 'agenda',
    text: '日程与计划',
    icon: 'agenda',
    group: '资料与事务',
    views: [
      { id: 'agenda', text: '日历与提醒' },
    ],
  },
  {
    id: 'mail',
    text: '邮箱工作台',
    icon: 'mail',
    group: '资料与事务',
    views: [{ id: 'mail', text: '邮箱工作台' }],
  },
  {
    id: 'activity',
    text: '通知与审批',
    icon: 'notifications',
    group: '资料与事务',
    views: [
      { id: 'notifications', text: '通知中心' },
      { id: 'approvals', text: '操作审批' },
    ],
  },
  {
    id: 'connections',
    text: '模型服务',
    icon: 'backends',
    group: '配置与维护',
    views: [
      { id: 'backends', text: '模型服务' },
    ],
  },
  {
    id: 'plugins',
    text: '扩展',
    icon: 'plugins',
    group: '配置与维护',
    views: [{ id: 'plugins', text: '扩展' }],
  },
  {
    id: 'system',
    text: '运行维护',
    icon: 'diagnostics',
    group: '配置与维护',
    views: [
      { id: 'diagnostics', text: '运行诊断' },
      { id: 'updates', text: '版本与更新' },
      { id: 'backup', text: '备份与恢复' },
    ],
  },
];
export const coreViews = new Set(['chat', 'character-session', 'automation', 'backends', 'plugins', 'diagnostics', 'updates']);
export function navigationSections(pages: FrontendPageEntry[] = []): Section[] {
  const result = sections.map((section) => ({ ...section, views: [...section.views] }));
  for (const page of pages) {
    if (page.placement === 'plugin-settings') continue;
    const parents = page.placement === 'settings' ? settingsSections : page.placement === 'character' ? new Set(['personas']) : workspaceSections;
    let section = page.section && parents.has(page.section) ? result.find((item) => item.id === page.section) : undefined;
    if (!section) {
      const id = 'extension-' + page.placement + '-' + page.owner;
      section = result.find((item) => item.id === id);
      if (!section) { section = { id, text: page.ownerName, icon: 'plugins', group: page.placement === 'settings' ? '配置与维护' : page.placement === 'character' ? '交流与陪伴' : '资料与事务', views: [] }; result.push(section); }
    }
    section.views.push({ id: page.id, text: page.title });
  }
  return result;
}
export const viewSection = (page: string, pages: FrontendPageEntry[] = []) =>
  navigationSections(pages).find((s) => s.views.some((v) => v.id === page));
export const workspaceSections = new Set(['automation', 'knowledge', 'agenda', 'mail', 'activity']);
export const settingsSections = new Set(['connections', 'plugins', 'system']);
export const isSettingsPage = (page: string, pages: FrontendPageEntry[] = []) =>
  (['settings', 'plugin-settings'].includes(pages.find((item) => item.id === page)?.placement ?? '') || settingsSections.has(viewSection(page)?.id ?? '')) && page !== 'channels';
export const isWorkspacePage = (page: string, pages: FrontendPageEntry[] = []) =>
  pages.find((item) => item.id === page)?.placement === 'workspace' || workspaceSections.has(viewSection(page)?.id ?? '');
import type { FrontendPageEntry } from '../../../packages/contracts/frontend.ts';
