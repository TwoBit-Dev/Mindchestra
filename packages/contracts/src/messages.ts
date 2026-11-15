import { z } from 'zod';
import { ISOTimeSchema, IdSchema, SlugIdSchema } from './agents.js';
import { PhaseSchema } from './missions.js';

export const AgentMessageSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  senderRunId: IdSchema,
  recipientAgentId: z.union([z.literal('all'), SlugIdSchema]),
  text: z.string().min(1).max(20000),
  phase: PhaseSchema,
  relatedClaimIds: z.array(IdSchema),
  at: ISOTimeSchema
}).strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
