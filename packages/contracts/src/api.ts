import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AgentManifestSchema,
  ISOTimeSchema,
  IdSchema,
  ProbeResultSchema,
  SlugIdSchema
} from './agents.js';
import { ApprovalRequestSchema } from './approvals.js';
import { ClaimSchema, EvidenceRefSchema, VerdictSchema } from './evidence.js';
import { MissionSnapshotSchema } from './missions.js';
import { ToolResultSchema } from './tools.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  const entries = keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]));
  return '{' + entries.join(',') + '}';
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface ActionHashInput {
  missionId: string;
  runId?: string;
  action: 'tool_write' | 'apply_patch' | 'external_send';
  target: string;
  argsOrPatchHash: string;
  schemaHash: string;
  policyVersion: number;
  baseCommit?: string;
}

export function computeActionHash(input: ActionHashInput): string {
  return sha256Hex(canonicalJson(input));
}

export function computeSchemaHash(schema: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(schema));
}

export const AgentConfigSchema = z.object({
  id: SlugIdSchema,
  adapterId: SlugIdSchema,
  model: z.string().min(1).max(120).optional(),
  executable: z.string().min(1).max(512).optional(),
  endpoint: z.string().url().max(2048).optional(),
  secretRef: z.string().min(1).max(128).optional()
}).strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentSummarySchema = z.object({
  manifest: AgentManifestSchema,
  probe: ProbeResultSchema.nullable()
}).strict();
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const WorkspaceCreateInputSchema = z.object({
  label: z.string().min(1).max(120),
  path: z.string().min(1).max(1024)
}).strict();
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>;

export const WorkspaceSummarySchema = z.object({
  id: SlugIdSchema,
  label: z.string().min(1).max(120)
}).strict();
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const MCPServerSummarySchema = z.object({
  id: SlugIdSchema,
  label: z.string().min(1).max(120),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'streamable-http']),
  status: z.string().min(1).max(64)
}).strict();
export type MCPServerSummary = z.infer<typeof MCPServerSummarySchema>;

export const ToolDescriptorSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  access: z.enum(['unclassified', 'read', 'write'])
}).strict();
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const ArtifactMetadataSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(128),
  pinned: z.boolean(),
  createdAt: ISOTimeSchema,
  expiresAt: ISOTimeSchema.optional()
}).strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string().min(1),
  schemaVersion: z.literal(1)
}).strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const MCPToolInvokeResultSchema = z.union([
  ToolResultSchema,
  z.object({
    status: z.literal('pending_approval'),
    approvalRequest: ApprovalRequestSchema
  }).strict()
]);
export type MCPToolInvokeResult = z.infer<typeof MCPToolInvokeResultSchema>;

export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable()
  }).strict();
}

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
};

export const EvidenceBundleResponseSchema = z.object({
  claims: z.array(ClaimSchema),
  evidence: z.array(EvidenceRefSchema),
  verdicts: z.array(VerdictSchema),
  nextCursor: z.string().nullable()
}).strict();
export type EvidenceBundleResponse = z.infer<typeof EvidenceBundleResponseSchema>;

export const ReplayResponseSchema = z.object({
  missionId: IdSchema,
  upToSeq: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  snapshot: MissionSnapshotSchema,
  claims: z.array(ClaimSchema),
  evidence: z.array(EvidenceRefSchema),
  verdicts: z.array(VerdictSchema),
  markdownSummary: z.string()
}).strict();
export type ReplayResponse = z.infer<typeof ReplayResponseSchema>;
