import { z } from 'zod';

export const reminderRulesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(80),
      outcome: z.enum(['remind', 'skip']),
      match: z.enum(['subject', 'sender', 'domain', 'domain-contains', 'reference']),
      terms: z.string().max(4000).default(''),
      exceptSenders: z.string().max(4000).default(''),
    }).refine((rule) => rule.match === 'reference' || Boolean(rule.terms.trim())),
  )
  .max(100);

export type ReminderRules = z.infer<typeof reminderRulesSchema>;
export const defaultReminderRules: ReminderRules = [
  {
    name: '推广邮件',
    outcome: 'skip',
    match: 'subject',
    terms: 'newsletter\nunsubscribe\n退订\n促销',
    exceptSenders: '',
  },
  {
    name: '有截止时间的事务',
    outcome: 'remind',
    match: 'subject',
    terms: 'deadline\n截止\n面试通知\n录用通知',
    exceptSenders: '',
  },
];

export const mailTerms = (value: string) =>
  value
    .split(/[\n,，]/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);

export function classifyReminder(mail: { subject: string; from: string }, rules: ReminderRules) {
  const subject = mail.subject.toLowerCase();
  const senders = mailTerms(mail.from);
  const domains = senders.map((sender) => sender.split('@').at(-1) ?? '');
  for (const rule of rules) {
    if (mailTerms(rule.exceptSenders).some((sender) => senders.includes(sender))) continue;
    const terms = mailTerms(rule.terms);
    const matches = {
      subject: () => terms.some((term) => subject.includes(term)),
      sender: () => terms.some((term) => senders.includes(term)),
      domain: () =>
        terms.some((term) =>
          domains.some((domain) => domain === term || domain.endsWith('.' + term)),
        ),
      'domain-contains': () =>
        terms.some((term) => domains.some((domain) => domain.includes(term))),
      // Kept only for exact replay of older filters during migration.
      reference: () => /\b[A-Z]{2,6}-\d{2,4}-[A-Z]-\d{5,8}\b/.test(mail.subject),
    };
    if (matches[rule.match]()) return { remind: rule.outcome === 'remind', rule: rule.name };
  }
  return { remind: false };
}
