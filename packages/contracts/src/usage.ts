import { z } from 'zod';

export const UsageSourceSchema = z.enum(['provider', 'measured', 'unknown']);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const UsageMetricsSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  durationMs: z.number().nonnegative(),
  source: UsageSourceSchema
}).strict();
export type UsageMetrics = z.infer<typeof UsageMetricsSchema>;
