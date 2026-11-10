/** Provider setup metadata shared with the UI. No user-specific domains or credentials. */
export const mailProviders = [
  {
    id: 'qq',
    name: 'QQ 邮箱',
    help: '在邮箱设置中开启 IMAP/SMTP，填写授权码。',
    url: 'https://mail.qq.com/',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
  },
  {
    id: 'gmail',
    name: 'Gmail',
    help: '开启两步验证后创建应用密码；部分组织账户不提供此选项。',
    url: 'https://support.google.com/accounts/answer/185833',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  },
  {
    id: 'institution',
    name: '学校或企业邮箱',
    help: '使用邮箱管理方提供的 IMAP、SMTP 地址和客户端密码。',
    url: '',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
  },
  {
    id: 'custom',
    name: '其他 IMAP 邮箱',
    help: '填写邮箱提供方的服务器设置；仅支持密码或应用密码认证。',
    url: '',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
  },
] as const;
export const inferMailProvider = (host: string) =>
  mailProviders.find((p) => p.imap.host && p.imap.host === host)?.id ?? 'custom';
