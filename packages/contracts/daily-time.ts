import { z } from 'zod';

export const dailyTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '请填写有效的 24 小时时间。');
export const followAppTimezone = 'app';
type Settings = Record<string, unknown>;

export function clockValue(settings: Settings) {
  const { hour, minute } = settings;
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return [hour, minute].map(part => String(part).padStart(2, '0')).join(':');
}

// Older clients still edit hour/minute. Translate at the task API boundary;
// persisted jobs, checkpoints and optimistic concurrency keep their original keys.
export const dailyTimeCodec = {
  view(settings: Settings) {
    const time = clockValue(settings);
    return time === undefined ? settings : { ...settings, dailyTime: time };
  },
  changes(settings: Settings, previous?: Settings) {
    if (!Object.hasOwn(settings, 'dailyTime')) return settings;
    const { dailyTime: input, ...rest } = settings;
    const time = dailyTime.parse(input);
    if (clockValue(rest) && time === clockValue(previous ?? { hour: 7, minute: 0 })) return rest;
    const [hour, minute] = time.split(':').map(Number);
    return { ...rest, hour, minute };
  },
};
