import { z } from 'zod';

export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

export const SlugIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,63}$/);
export type SlugId = z.infer<typeof SlugIdSchema>;

export const ISOTimeSchema = z.string().datetime({ offset: true });
export type ISOTime = z.infer<typeof ISOTimeSchema>;

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  resume: z.boolean(),
  steer: z.boolean(),
  usage: z.boolean(),
  vision: z.boolean(),
  workspaceWrite: z.boolean(),
  nativeSandbox: z.boolean(),
  structuredOutput: z.boolean()
}).strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const DEFAULT_FALSE_CAPABILITIES: AgentCapabilities = {
  streaming: false,
  tools: false,
  resume: false,
  steer: false,
  usage: false,
  vision: false,
  workspaceWrite: false,
  nativeSandbox: false,
  structuredOutput: false
};

export function resolveCapabilities(
  declared: Partial<AgentCapabilities>,
  observed: Partial<AgentCapabilities>,
  policy: Partial<AgentCapabilities>
): AgentCapabilities {
  return {
    streaming: Boolean(declared.streaming && observed.streaming && policy.streaming),
    tools: Boolean(declared.tools && observed.tools && policy.tools),
    resume: Boolean(declared.resume && observed.resume && policy.resume),
    steer: Boolean(declared.steer && observed.steer && policy.steer),
    usage: Boolean(declared.usage && observed.usage && policy.usage),
    vision: Boolean(declared.vision && observed.vision && policy.vision),
    workspaceWrite: Boolean(declared.workspaceWrite && observed.workspaceWrite && policy.workspaceWrite),
    nativeSandbox: Boolean(declared.nativeSandbox && observed.nativeSandbox && policy.nativeSandbox),
    structuredOutput: Boolean(declared.structuredOutput && observed.structuredOutput && policy.structuredOutput)
  };
}

export const AgentKindSchema = z.enum(['cli', 'api', 'local', 'custom', 'remote']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentManifestSchema = z.object({
  id: SlugIdSchema,
  displayName: z.string().min(1).max(120),
  provider: z.string().min(1).max(64),
  adapterVersion: z.string().min(1).max(32),
  sdkVersion: z.literal(1),
  kind: AgentKindSchema,
  capabilities: AgentCapabilitiesSchema,
  models: z.array(z.string().min(1).max(120)).optional()
}).strict();
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const ProbeStatusSchema = z.enum([
  'ready',
  'unavailable',
  'auth_required',
  'incompatible',
  'offline',
  'error'
]);
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

export const ProbeResultSchema = z.object({
  status: ProbeStatusSchema,
  checkedAt: ISOTimeSchema,
  version: z.string().min(1).max(64).optional(),
  detail: z.string().max(1000).optional(),
  capabilities: AgentCapabilitiesSchema
}).strict();
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
