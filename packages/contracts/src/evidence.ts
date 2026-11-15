import { z } from 'zod';
import { ISOTimeSchema, IdSchema } from './agents.js';

export const ClaimSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type ClaimSeverity = z.infer<typeof ClaimSeveritySchema>;

export const ClaimStatusSchema = z.enum(['unverified', 'verified', 'disputed', 'rejected']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ClaimSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  runId: IdSchema,
  text: z.string().min(1).max(10000),
  severity: ClaimSeveritySchema,
  status: ClaimStatusSchema,
  supersedesId: IdSchema.optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const EvidenceKindSchema = z.enum(['source', 'test', 'tool', 'artifact', 'external']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceRelationSchema = z.enum(['supports', 'contradicts', 'duplicates', 'supersedes']);
export type EvidenceRelation = z.infer<typeof EvidenceRelationSchema>;

export const EvidenceProvenanceSchema = z.enum([
  'agent_report',
  'trusted_runner',
  'gateway',
  'user'
]);
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;

export const EvidenceStatusSchema = z.enum(['unverified', 'verified', 'stale', 'rejected']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceRefSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  claimId: IdSchema,
  kind: EvidenceKindSchema,
  relation: EvidenceRelationSchema,
  sourceRef: z.string().min(1).max(1024),
  artifactId: IdSchema.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baseCommit: z.string().min(1).max(64).optional(),
  toolVersion: z.string().min(1).max(64).optional(),
  at: ISOTimeSchema,
  provenance: EvidenceProvenanceSchema,
  status: EvidenceStatusSchema
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const GateStatusSchema = z.enum(['pass', 'fail', 'unknown']);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GateResultSchema = z.object({
  gateId: z.string().min(1).max(64),
  status: GateStatusSchema,
  evidenceIds: z.array(IdSchema),
  detail: z.string().max(2000).optional()
}).strict();
export type GateResult = z.infer<typeof GateResultSchema>;

export const VerdictStatusSchema = z.enum(['verified', 'provisional', 'rejected', 'disputed']);
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

export const VerdictSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  claimIds: z.array(IdSchema),
  status: VerdictStatusSchema,
  rubricId: z.string().min(1).max(64),
  gateResults: z.array(GateResultSchema),
  evidenceIds: z.array(IdSchema),
  reason: z.string().min(1).max(4000),
  dissent: z.array(z.string().min(1).max(2000)),
  candidateArtifactId: IdSchema.optional(),
  score: z.number().min(0).max(100).nullable().optional()
}).strict();
export type Verdict = z.infer<typeof VerdictSchema>;
