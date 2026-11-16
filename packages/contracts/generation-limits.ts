import { z } from 'zod';

/** A per-response protocol setting, never an accumulated Agent task budget. */
export const outputTokenLimit = z.number().int().min(64).safe();
/** Used only when a custom endpoint declares no model output capacity. */
export const defaultOutputTokens = 65536;
