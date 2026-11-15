import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  EvidenceRelationSchema,
  IdSchema,
  MindchestraError,
  MissionSpecSchema,
  SlugIdSchema,
  UPSTREAM_MCP_TOOLS,
  type UpstreamMcpToolName
} from '@mindchestra/contracts';
import { RecursiveGuard, redactText, type CallerIdentity } from '@mindchestra/policy';
import { z } from 'zod';
import type { DaemonMcpBackend } from './http-backend.js';

export interface UpstreamMcpConfig {
  backend: DaemonMcpBackend;
  caller: CallerIdentity;
  recursiveGuard?: RecursiveGuard;
  logError?: (message: string) => void;
}

function formatSuccess(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }]
  };
}

function formatError(error: unknown, logError?: (message: string) => void): CallToolResult {
  const err =
    error instanceof MindchestraError
      ? error
      : new MindchestraError('INTERNAL', error instanceof Error ? error.message : 'Unexpected tool error');
  const sanitizedMessage = redactText(err.message);
  if (logError) {
    logError(`[mcp-server] ${err.code}: ${sanitizedMessage}`);
  } else {
    process.stderr.write(`[mcp-server] ${err.code}: ${sanitizedMessage}\n`);
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: err.code,
            message: sanitizedMessage,
            retryable: err.retryable
          }
        })
      }
    ]
  };
}

export class UpstreamMcpDispatcher {
  private readonly recursiveGuard: RecursiveGuard;

  constructor(private readonly config: UpstreamMcpConfig) {
    this.recursiveGuard = config.recursiveGuard ?? new RecursiveGuard();
  }

  listRegisteredTools(): readonly UpstreamMcpToolName[] {
    return UPSTREAM_MCP_TOOLS;
  }

  async callTool(name: UpstreamMcpToolName, rawArgs: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const caller = this.config.caller;
      switch (name) {
        case 'mission.start': {
          const spec = MissionSpecSchema.parse(rawArgs);
          this.recursiveGuard.assertCanStartMission(caller, spec);
          const snapshot = await this.config.backend.startMission(caller, spec);
          return formatSuccess({ missionId: snapshot.id, status: snapshot.status });
        }
        case 'mission.status': {
          const { missionId } = z.object({ missionId: IdSchema }).strict().parse(rawArgs);
          return formatSuccess(await this.config.backend.getMissionStatus(caller, missionId));
        }
        case 'mission.result': {
          const { missionId } = z.object({ missionId: IdSchema }).strict().parse(rawArgs);
          return formatSuccess(await this.config.backend.getMissionResult(caller, missionId));
        }
        case 'mission.cancel': {
          const { missionId } = z.object({ missionId: IdSchema }).strict().parse(rawArgs);
          return formatSuccess(await this.config.backend.cancelMission(caller, missionId));
        }
        case 'agent.list': {
          z.object({}).strict().parse(rawArgs);
          return formatSuccess(await this.config.backend.listAgents(caller));
        }
        case 'agent.probe': {
          const { agentId } = z.object({ agentId: SlugIdSchema }).strict().parse(rawArgs);
          return formatSuccess(await this.config.backend.probeAgent(caller, agentId));
        }
        case 'agent.send': {
          const parsed = z
            .object({
              missionId: IdSchema,
              recipientAgentId: z.union([z.literal('all'), SlugIdSchema]),
              text: z.string().min(1).max(20000),
              relatedClaimIds: z.array(IdSchema).default([])
            })
            .strict()
            .parse(rawArgs);
          if (caller.missionId && caller.missionId !== parsed.missionId) {
            throw new MindchestraError('FORBIDDEN', 'Caller session cannot message another mission');
          }
          return formatSuccess(await this.config.backend.sendAgentMessage(caller, parsed));
        }
        case 'evidence.submit': {
          const parsed = z
            .object({
              missionId: IdSchema,
              claimId: IdSchema,
              sourceRef: z.string().min(1).max(1024),
              relation: EvidenceRelationSchema,
              artifactId: IdSchema.optional()
            })
            .strict()
            .parse(rawArgs);
          if (caller.missionId && caller.missionId !== parsed.missionId) {
            throw new MindchestraError('FORBIDDEN', 'Caller session cannot submit evidence to another mission');
          }
          return formatSuccess(await this.config.backend.submitEvidence(caller, parsed));
        }
        case 'tools.discover': {
          const parsed = z.object({ serverId: SlugIdSchema.optional() }).strict().parse(rawArgs);
          return formatSuccess({
            items: await this.config.backend.discoverTools(caller, parsed.serverId)
          });
        }
        case 'tools.invoke': {
          const parsed = z
            .object({
              missionId: IdSchema,
              serverId: SlugIdSchema,
              toolName: z.string().min(1).max(256),
              arguments: z.record(z.string(), z.unknown()),
              claimId: IdSchema.optional()
            })
            .strict()
            .parse(rawArgs);
          if (caller.missionId && caller.missionId !== parsed.missionId) {
            throw new MindchestraError('FORBIDDEN', 'Caller session cannot invoke tools for another mission');
          }
          return formatSuccess(await this.config.backend.invokeTool(caller, parsed));
        }
        case 'approval.list': {
          const { missionId } = z.object({ missionId: IdSchema }).strict().parse(rawArgs);
          return formatSuccess({
            items: await this.config.backend.listApprovals(caller, missionId)
          });
        }
      }
    } catch (error) {
      return formatError(error, this.config.logError);
    }
  }
}

export function createUpstreamMcpServer(config: UpstreamMcpConfig): {
  server: McpServer;
  dispatcher: UpstreamMcpDispatcher;
} {
  const dispatcher = new UpstreamMcpDispatcher(config);
  const server = new McpServer({
    name: 'mindchestra',
    version: '0.1.0'
  });

  server.tool(
    'mission.start',
    'Start an orchestration mission from a MissionSpec',
    {
      schemaVersion: z.literal(1),
      objective: z.string().min(1).max(20000),
      mode: z.string(),
      agents: z.array(z.string()),
      workspace: z.string(),
      profile: z.enum(['read-only', 'isolated-write']),
      budget: z.object({
        maxRuns: z.number().int(),
        maxSeconds: z.number().int(),
        maxRounds: z.number().int(),
        maxConcurrency: z.number().int(),
        maxToolCalls: z.number().int(),
        maxTokens: z.number().int().optional()
      }),
      rubricId: z.string().optional(),
      inputArtifactIds: z.array(z.string()).optional(),
      candidateArtifactId: z.string().optional()
    },
    (args) => dispatcher.callTool('mission.start', args)
  );

  server.tool(
    'mission.status',
    'Get current mission snapshot status',
    { missionId: z.string().uuid() },
    (args) => dispatcher.callTool('mission.status', args)
  );

  server.tool(
    'mission.result',
    'Get finalized mission result',
    { missionId: z.string().uuid() },
    (args) => dispatcher.callTool('mission.result', args)
  );

  server.tool(
    'mission.cancel',
    'Cancel an active mission',
    { missionId: z.string().uuid() },
    (args) => dispatcher.callTool('mission.cancel', args)
  );

  server.tool('agent.list', 'List registered agent adapters and probes', {}, (args) =>
    dispatcher.callTool('agent.list', args)
  );

  server.tool(
    'agent.probe',
    'Probe a registered agent adapter',
    { agentId: z.string() },
    (args) => dispatcher.callTool('agent.probe', args)
  );

  server.tool(
    'agent.send',
    'Send a bounded peer message after phase barrier unlocks',
    {
      missionId: z.string().uuid(),
      recipientAgentId: z.string(),
      text: z.string().min(1),
      relatedClaimIds: z.array(z.string().uuid()).default([])
    },
    (args) => dispatcher.callTool('agent.send', args)
  );

  server.tool(
    'evidence.submit',
    'Submit unverified evidence reference attached to a claim',
    {
      missionId: z.string().uuid(),
      claimId: z.string().uuid(),
      sourceRef: z.string().min(1),
      relation: EvidenceRelationSchema,
      artifactId: z.string().uuid().optional()
    },
    (args) => dispatcher.callTool('evidence.submit', args)
  );

  server.tool(
    'tools.discover',
    'Discover permitted downstream MCP tools',
    { serverId: z.string().optional() },
    (args) => dispatcher.callTool('tools.discover', args)
  );

  server.tool(
    'tools.invoke',
    'Invoke a downstream MCP tool under policy grant',
    {
      missionId: z.string().uuid(),
      serverId: z.string(),
      toolName: z.string(),
      arguments: z.record(z.string(), z.unknown()),
      claimId: z.string().uuid().optional()
    },
    (args) => dispatcher.callTool('tools.invoke', args)
  );

  server.tool(
    'approval.list',
    'List approval requests for a mission (read-only)',
    { missionId: z.string().uuid() },
    (args) => dispatcher.callTool('approval.list', args)
  );

  return { server, dispatcher };
}

export async function startUpstreamStdioServer(config: UpstreamMcpConfig): Promise<McpServer> {
  const { server } = createUpstreamMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
