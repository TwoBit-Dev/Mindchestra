import { z } from 'zod';
import { ISOTimeSchema, IdSchema, SlugIdSchema } from './agents.js';

export const MCPStdioTransportSchema = z.object({
  kind: z.literal('stdio'),
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(1024)),
  envSecretRefs: z.record(z.string().min(1), z.string().min(1)).optional()
}).strict();

export const MCPStreamableHttpTransportSchema = z.object({
  kind: z.literal('streamable-http'),
  url: z.string().url().max(2048),
  authSecretRef: z.string().min(1).max(128).optional()
}).strict();

export const MCPTransportSchema = z.discriminatedUnion('kind', [
  MCPStdioTransportSchema,
  MCPStreamableHttpTransportSchema
]);
export type MCPTransport = z.infer<typeof MCPTransportSchema>;

export const MCPServerConfigSchema = z.object({
  id: SlugIdSchema,
  label: z.string().min(1).max(120),
  enabled: z.boolean(),
  transport: MCPTransportSchema
}).strict();
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const ToolGrantSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  agentId: SlugIdSchema,
  serverId: SlugIdSchema,
  toolName: z.string().min(1).max(256),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  access: z.enum(['read', 'write']),
  expiresAt: ISOTimeSchema,
  maxCalls: z.number().int().positive().max(1000)
}).strict();
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const UPSTREAM_MCP_TOOLS = [
  'mission.start',
  'mission.status',
  'mission.result',
  'mission.cancel',
  'agent.list',
  'agent.probe',
  'agent.send',
  'evidence.submit',
  'tools.discover',
  'tools.invoke',
  'approval.list'
] as const;

export type UpstreamMcpToolName = (typeof UPSTREAM_MCP_TOOLS)[number];
