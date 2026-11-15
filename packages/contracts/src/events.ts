import { z } from 'zod';
import { ISOTimeSchema, IdSchema } from './agents.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema } from './approvals.js';
import { ErrorResponseSchema } from './errors.js';
import { ClaimSchema, EvidenceRefSchema, VerdictSchema } from './evidence.js';
import { AgentMessageSchema } from './messages.js';
import { MissionResultSchema, MissionSpecSchema, MissionStatusSchema, PhaseSchema } from './missions.js';
import { ToolCallSchema, ToolResultSchema } from './tools.js';
import { UsageMetricsSchema } from './usage.js';

const agentStartedVariant = z.object({
  type: z.literal('agent.started'),
  payload: z.object({
    providerSessionId: z.string().min(1).optional()
  }).strict()
});

const messageDeltaVariant = z.object({
  type: z.literal('message.delta'),
  payload: z.object({
    messageId: IdSchema,
    text: z.string()
  }).strict()
});

const messageCompletedVariant = z.object({
  type: z.literal('message.completed'),
  payload: z.object({
    messageId: IdSchema,
    text: z.string()
  }).strict()
});

const usageUpdatedVariant = z.object({
  type: z.literal('usage.updated'),
  payload: UsageMetricsSchema
});

const toolObservedVariant = z.object({
  type: z.literal('tool.observed'),
  payload: z.object({
    name: z.string().min(1),
    detail: z.string().optional()
  }).strict()
});

const agentFinishedVariant = z.object({
  type: z.literal('agent.finished'),
  payload: z.object({
    summary: z.string()
  }).strict()
});

const agentFailedVariant = z.object({
  type: z.literal('agent.failed'),
  payload: ErrorResponseSchema
});

const missionCreatedVariant = z.object({
  type: z.literal('mission.created'),
  payload: z.object({ spec: MissionSpecSchema }).strict()
});

const missionPhaseVariant = z.object({
  type: z.literal('mission.phase'),
  payload: z.object({ phase: PhaseSchema }).strict()
});

const missionStatusVariant = z.object({
  type: z.literal('mission.status'),
  payload: z.object({ status: MissionStatusSchema }).strict()
});

const agentMessageVariant = z.object({
  type: z.literal('agent.message'),
  payload: AgentMessageSchema
});

const claimCreatedVariant = z.object({
  type: z.literal('claim.created'),
  payload: ClaimSchema
});

const evidenceAddedVariant = z.object({
  type: z.literal('evidence.added'),
  payload: EvidenceRefSchema
});

const verdictCreatedVariant = z.object({
  type: z.literal('verdict.created'),
  payload: VerdictSchema
});

const approvalRequestedVariant = z.object({
  type: z.literal('approval.requested'),
  payload: ApprovalRequestSchema
});

const approvalDecidedVariant = z.object({
  type: z.literal('approval.decided'),
  payload: ApprovalDecisionSchema
});

const toolCalledVariant = z.object({
  type: z.literal('tool.called'),
  payload: ToolCallSchema
});

const toolCompletedVariant = z.object({
  type: z.literal('tool.completed'),
  payload: ToolResultSchema
});

const missionResultVariant = z.object({
  type: z.literal('mission.result'),
  payload: MissionResultSchema
});

export const AdapterEventSchema = z.discriminatedUnion('type', [
  agentStartedVariant.strict(),
  messageDeltaVariant.strict(),
  messageCompletedVariant.strict(),
  usageUpdatedVariant.strict(),
  toolObservedVariant.strict(),
  agentFinishedVariant.strict(),
  agentFailedVariant.strict()
]);
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;

export const CoreEventSchema = z.discriminatedUnion('type', [
  missionCreatedVariant.strict(),
  missionPhaseVariant.strict(),
  missionStatusVariant.strict(),
  agentMessageVariant.strict(),
  claimCreatedVariant.strict(),
  evidenceAddedVariant.strict(),
  verdictCreatedVariant.strict(),
  approvalRequestedVariant.strict(),
  approvalDecidedVariant.strict(),
  toolCalledVariant.strict(),
  toolCompletedVariant.strict(),
  missionResultVariant.strict()
]);
export type CoreEvent = z.infer<typeof CoreEventSchema>;

export const AgentEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  seq: z.number().int().positive(),
  id: IdSchema,
  missionId: IdSchema,
  actor: z.string().min(1).max(128),
  at: ISOTimeSchema,
  correlationId: IdSchema,
  runId: IdSchema.optional(),
  causationId: IdSchema.optional()
});
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;

export const AgentEventPayloadSchema = z.union([AdapterEventSchema, CoreEventSchema]);
export type AgentEventPayload = z.infer<typeof AgentEventPayloadSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  agentStartedVariant.merge(AgentEventEnvelopeSchema).strict(),
  messageDeltaVariant.merge(AgentEventEnvelopeSchema).strict(),
  messageCompletedVariant.merge(AgentEventEnvelopeSchema).strict(),
  usageUpdatedVariant.merge(AgentEventEnvelopeSchema).strict(),
  toolObservedVariant.merge(AgentEventEnvelopeSchema).strict(),
  agentFinishedVariant.merge(AgentEventEnvelopeSchema).strict(),
  agentFailedVariant.merge(AgentEventEnvelopeSchema).strict(),
  missionCreatedVariant.merge(AgentEventEnvelopeSchema).strict(),
  missionPhaseVariant.merge(AgentEventEnvelopeSchema).strict(),
  missionStatusVariant.merge(AgentEventEnvelopeSchema).strict(),
  agentMessageVariant.merge(AgentEventEnvelopeSchema).strict(),
  claimCreatedVariant.merge(AgentEventEnvelopeSchema).strict(),
  evidenceAddedVariant.merge(AgentEventEnvelopeSchema).strict(),
  verdictCreatedVariant.merge(AgentEventEnvelopeSchema).strict(),
  approvalRequestedVariant.merge(AgentEventEnvelopeSchema).strict(),
  approvalDecidedVariant.merge(AgentEventEnvelopeSchema).strict(),
  toolCalledVariant.merge(AgentEventEnvelopeSchema).strict(),
  toolCompletedVariant.merge(AgentEventEnvelopeSchema).strict(),
  missionResultVariant.merge(AgentEventEnvelopeSchema).strict()
]);
export type AgentEvent = (AdapterEvent | CoreEvent) & AgentEventEnvelope;
