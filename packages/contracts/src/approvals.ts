import { z } from 'zod';
import { ISOTimeSchema, IdSchema } from './agents.js';

export const ApprovalActionSchema = z.enum(['tool_write', 'apply_patch', 'external_send']);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const ApprovalRiskSchema = z.enum(['medium', 'high', 'critical']);
export type ApprovalRisk = z.infer<typeof ApprovalRiskSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'consumed']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRequestSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  runId: IdSchema.optional(),
  action: ApprovalActionSchema,
  target: z.string().min(1).max(512),
  risk: ApprovalRiskSchema,
  summary: z.string().min(1).max(1000),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: ISOTimeSchema,
  expiresAt: ISOTimeSchema,
  status: ApprovalStatusSchema
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalInputSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().max(1000).optional()
}).strict();
export type ApprovalInput = z.infer<typeof ApprovalInputSchema>;

export const ApprovalDecisionSchema = ApprovalInputSchema.extend({
  approvalId: IdSchema,
  decidedAt: ISOTimeSchema,
  decidedBy: z.string().min(1).max(128)
}).strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
