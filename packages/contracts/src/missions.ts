import { z } from 'zod';
import { ISOTimeSchema, IdSchema, SlugIdSchema } from './agents.js';

export const ModeSchema = z.enum([
  'council',
  'parallel',
  'review',
  'debate',
  'team',
  'competition',
  'debug',
  'mcp_pipeline',
  'research',
  'auto'
]);
export type Mode = z.infer<typeof ModeSchema>;

export const MVP_MODES = ['council', 'parallel', 'review'] as const;
export const MAX_MVP_AGENTS = 3;

export const ProfileSchema = z.enum(['read-only', 'isolated-write']);
export type Profile = z.infer<typeof ProfileSchema>;

export const BudgetSchema = z.object({
  maxRuns: z.number().int().min(1).max(50),
  maxSeconds: z.number().int().min(1).max(3600),
  maxRounds: z.number().int().min(1).max(10),
  maxConcurrency: z.number().int().min(1).max(10),
  maxToolCalls: z.number().int().min(0).max(500),
  maxTokens: z.number().int().positive().optional()
}).strict();
export type Budget = z.infer<typeof BudgetSchema>;

export const DEFAULT_BUDGET: Budget = {
  maxRuns: 7,
  maxSeconds: 600,
  maxRounds: 2,
  maxConcurrency: 3,
  maxToolCalls: 20
};

export const MissionSpecSchema = z.object({
  schemaVersion: z.literal(1),
  objective: z.string().min(1).max(20000),
  mode: ModeSchema,
  agents: z.array(SlugIdSchema).min(1).max(10).refine(
    (agents) => new Set(agents).size === agents.length,
    { message: 'agents must be unique' }
  ),
  workspace: SlugIdSchema,
  profile: ProfileSchema,
  budget: BudgetSchema,
  rubricId: z.string().min(1).max(64).optional(),
  inputArtifactIds: z.array(IdSchema).max(50).optional(),
  candidateArtifactId: IdSchema.optional()
}).strict().superRefine((spec, ctx) => {
  if (spec.mode === 'review' && spec.candidateArtifactId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateArtifactId'],
      message: 'candidateArtifactId is required for review mode'
    });
  }
});
export type MissionSpec = z.infer<typeof MissionSpecSchema>;

export const MissionStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'cancel_requested',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted'
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = [
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted'
];

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.includes(status);
}

export const PhaseSchema = z.enum([
  'prepare',
  'independent',
  'critique',
  'verify',
  'synthesize',
  'finalize'
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const RunRequestSchema = z.object({
  missionId: IdSchema,
  runId: IdSchema,
  agentId: SlugIdSchema,
  phase: PhaseSchema,
  prompt: z.string().min(1).max(50000),
  workspacePath: z.string().min(1),
  baseCommit: z.string().min(1).max(64).optional(),
  profile: ProfileSchema,
  deadlineAt: ISOTimeSchema,
  toolGrantIds: z.array(IdSchema),
  inputArtifactIds: z.array(IdSchema),
  model: z.string().min(1).max(120).optional(),
  sessionId: z.string().min(1).max(256).optional()
}).strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const ResumeRequestSchema = RunRequestSchema.extend({
  sessionId: z.string().min(1).max(256)
}).strict();
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export const MissionSnapshotSchema = z.object({
  id: IdSchema,
  spec: MissionSpecSchema,
  status: MissionStatusSchema,
  phase: PhaseSchema,
  createdAt: ISOTimeSchema,
  updatedAt: ISOTimeSchema,
  lastSeq: z.number().int().nonnegative(),
  resultAvailable: z.boolean(),
  pendingApprovalIds: z.array(IdSchema),
  baseCommit: z.string().min(1).max(64).optional(),
  parentMissionId: IdSchema.optional()
}).strict();
export type MissionSnapshot = z.infer<typeof MissionSnapshotSchema>;

export const MissionResultSchema = z.object({
  missionId: IdSchema,
  status: MissionStatusSchema,
  summary: z.string(),
  claims: z.array(IdSchema),
  evidence: z.array(IdSchema),
  verdicts: z.array(IdSchema),
  artifactIds: z.array(IdSchema),
  unresolved: z.array(z.string())
}).strict();
export type MissionResult = z.infer<typeof MissionResultSchema>;
