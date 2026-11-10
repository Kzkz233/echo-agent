import type { ChannelTextMode } from '../../packages/contracts/delivery.ts';

const characterLimit = 1500;

function lengthChunks(text: string) {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let start = 0; start < characters.length; start += characterLimit)
    chunks.push(characters.slice(start, start + characterLimit).join(''));
  return chunks;
}

export function qqTextParts(
  text: string,
  budget: number,
  hasImage: boolean,
  mode: ChannelTextMode = 'auto',
  explicit?: string[],
) {
  const required = lengthChunks(text);
  if (mode === 'combined') return required;
  const textBudget = budget - Number(hasImage && required.length < budget);
  if (explicit) {
    const chunks = explicit.flatMap(lengthChunks);
    return chunks.length <= textBudget ? chunks : required;
  }
  const structured = /^[ \t]*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---+[ \t]*\r?$)/m.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~/.test(text);
  if (structured || textBudget < 2) return required;

  const paragraphs = text.split(/\r?\n(?:[ \t]*\r?\n)+/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length < 2) return required;
  const lastPart = Math.min(3, textBudget) - 1;
  const preferred = [...paragraphs.slice(0, lastPart), paragraphs.slice(lastPart).join('\n\n')]
    .flatMap(lengthChunks);
  return preferred.length <= textBudget ? preferred : required;
}
