import type { z } from 'zod';
import type { transcriptionOutput } from '../../packages/contracts/speech.ts';
import type { parseAssessment } from '../../packages/contracts/parsing.ts';

/** An output's existence is not proof of speech. Rejected candidates stay in the job receipt. */
export function assessTranscription(
  result: z.infer<typeof transcriptionOutput>,
  seconds: number,
): z.infer<typeof parseAssessment> {
  const text = result.text.trim();
  if (!text) return { state: 'needs_review', reason: 'speech_without_transcript' };
  if (/^none$/i.test(result.language ?? ''))
    return { state: 'needs_review', reason: 'no_speech_conflict' };
  if (/<(?:\|[^>]*\|>|asr_text>)/.test(text))
    return { state: 'needs_review', reason: 'invalid_protocol' };
  if ([...text].length / Math.max(0.25, seconds) > 40)
    return { state: 'needs_review', reason: 'implausible_text_rate' };
  // Highly degenerate generation is retained for review, never silently corrected.
  if (/(.{2,40})\1{7,}/u.test(text))
    return { state: 'needs_review', reason: 'repetitive_generation' };
  return { state: 'accepted' };
}
