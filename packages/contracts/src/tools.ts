import { z } from 'zod';
import { IdSchema, SlugIdSchema } from './agents.js';
import { ErrorResponseSchema } from './errors.js';

export const MAX_TOOL_ARGS_BYTES = 256 * 1024;

export const ToolCallSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  runId: IdSchema,
  serverId: SlugIdSchema,
  toolName: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).refine(
    (args) => Buffer.byteLength(JSON.stringify(args), 'utf8') <= MAX_TOOL_ARGS_BYTES,
    { message: 'tool arguments exceed 256 KiB limit' }
  ),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  grantId: IdSchema,
  approvalId: IdSchema.optional()
}).strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultStatusSchema = z.enum([
  'ok',
  'error',
  'denied',
  'timeout',
  'unknown_outcome'
]);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

export const ToolResultSchema = z.object({
  callId: IdSchema,
  status: ToolResultStatusSchema,
  artifactIds: z.array(IdSchema),
  summary: z.string().max(4000),
  error: ErrorResponseSchema.optional()
}).strict();
export type ToolResult = z.infer<typeof ToolResultSchema>;
