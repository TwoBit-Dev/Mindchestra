import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  EvidenceRefSchema,
  MAX_TOOL_ARGS_BYTES,
  MCPServerConfigSchema,
  MindchestraError,
  ToolCallSchema,
  ToolDescriptorSchema,
  ToolResultSchema,
  computeSchemaHash,
  type EvidenceRef,
  type MCPServerConfig,
  type MCPServerSummary,
  type MCPToolInvokeResult,
  type Profile,
  type ToolDescriptor,
  type ToolResult
} from '@mindchestra/contracts';
import {
  PolicyEngine,
  assertSafeResolvedIps,
  redactText,
  redactValue,
  sanitizeMcpServerConfig,
  validateMcpHttpUrl,
  type CallerIdentity
} from '@mindchestra/policy';
import type { ArtifactStore, EventStore, StorageRepositories } from '@mindchestra/storage';
import { scrubEnvironment } from '@mindchestra/workspaces';
import dns from 'node:dns/promises';

export interface DiscoveredRawTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface DownstreamMcpTransportClient {
  listAllTools(signal?: AbortSignal): Promise<DiscoveredRawTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ text: string; raw: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

export type DownstreamClientFactory = (config: MCPServerConfig) => Promise<DownstreamMcpTransportClient>;

export interface McpGatewayOptions {
  allowLoopbackHttp?: boolean;
  defaultTimeoutMs?: number;
  clientFactory?: DownstreamClientFactory;
}

class StdioSdkTransportClient implements DownstreamMcpTransportClient {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport
  ) {}

  static async connect(
    config: Extract<MCPServerConfig['transport'], { kind: 'stdio' }>
  ): Promise<StdioSdkTransportClient> {
    if (!config.command || /[\0\r\n;|&$`><]/.test(config.command)) {
      throw new MindchestraError('INVALID_INPUT', 'Unsafe MCP stdio command rejected');
    }
    const env = scrubEnvironment(process.env);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
      stderr: 'pipe'
    });
    const client = new Client(
      { name: 'mindchestra-gateway', version: '0.1.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    return new StdioSdkTransportClient(client, transport);
  }

  async listAllTools(signal?: AbortSignal): Promise<DiscoveredRawTool[]> {
    const tools: DiscoveredRawTool[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (signal?.aborted) {
        throw new MindchestraError('CANCELLED', 'Tool discovery cancelled');
      }
      const res = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of res.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>
        });
      }
      if (res.nextCursor) {
        if (seenCursors.has(res.nextCursor)) {
          break;
        }
        seenCursors.add(res.nextCursor);
      }
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ text: string; raw: unknown; isError?: boolean }> {
    const res = await this.client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined
    );
    const contentList = Array.isArray(res.content) ? res.content : [];
    const textParts = contentList
      .filter((item): item is { type: 'text'; text: string } => Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text'))
      .map((item) => item.text);
    return {
      text: textParts.join('\n') || JSON.stringify(res),
      raw: res,
      isError: Boolean(res.isError)
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

class StreamableHttpMcpClient implements DownstreamMcpTransportClient {
  private requestSeq = 1;
  private sessionId: string | undefined;

  constructor(
    private readonly endpoint: URL,
    private readonly allowLoopbackHttp: boolean
  ) {}

  private async postJsonRpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.requestSeq++,
      method,
      params
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const res = await fetch(this.endpoint.toString(), {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        validateMcpHttpUrl(new URL(location, this.endpoint).toString(), {
          allowLoopbackHttp: this.allowLoopbackHttp
        });
      }
      throw new MindchestraError('FORBIDDEN', 'Unexpected redirect from MCP HTTP endpoint');
    }

    const nextSession = res.headers.get('mcp-session-id');
    if (nextSession) {
      this.sessionId = nextSession;
    }

    if (!res.ok) {
      throw new MindchestraError('UNAVAILABLE', `MCP HTTP endpoint returned status ${res.status}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      const dataLines = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter(Boolean);
      const last = dataLines[dataLines.length - 1];
      if (!last) {
        throw new MindchestraError('INTERNAL', 'Empty SSE response from MCP endpoint');
      }
      const parsed = JSON.parse(last) as { result?: unknown; error?: { message?: string } };
      if (parsed.error) {
        throw new MindchestraError('INTERNAL', parsed.error.message ?? 'MCP JSON-RPC error');
      }
      return parsed.result;
    }

    const parsed = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) {
      throw new MindchestraError('INTERNAL', parsed.error.message ?? 'MCP JSON-RPC error');
    }
    return parsed.result;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.postJsonRpc(
      'initialize',
      {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'mindchestra-gateway', version: '0.1.0' }
      },
      signal
    );
  }

  async listAllTools(signal?: AbortSignal): Promise<DiscoveredRawTool[]> {
    const tools: DiscoveredRawTool[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.postJsonRpc(
        'tools/list',
        cursor ? { cursor } : {},
        signal
      )) as { tools?: DiscoveredRawTool[]; nextCursor?: string };
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: 'object' }
          });
        }
      }
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ text: string; raw: unknown; isError?: boolean }> {
    const result = (await this.postJsonRpc(
      'tools/call',
      { name, arguments: args },
      signal
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (result.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text!)
      .join('\n');
    return {
      text: text || JSON.stringify(result),
      raw: result,
      isError: Boolean(result.isError)
    };
  }

  async close(): Promise<void> {
    return;
  }
}

export class McpGateway {
  private readonly allowLoopbackHttp: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly clientFactory?: DownstreamClientFactory;

  constructor(
    private readonly repos: StorageRepositories,
    private readonly eventStore: EventStore,
    private readonly artifacts: ArtifactStore,
    private readonly policy: PolicyEngine,
    options?: McpGatewayOptions
  ) {
    this.allowLoopbackHttp = options?.allowLoopbackHttp ?? false;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 15000;
    this.clientFactory = options?.clientFactory;
  }

  registerServer(rawConfig: unknown): MCPServerSummary {
    const parsed = MCPServerConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new MindchestraError('INVALID_INPUT', 'Invalid MCPServerConfig', {
        details: { issues: parsed.error.issues }
      });
    }
    const config = parsed.data;
    if (config.transport.kind === 'streamable-http') {
      validateMcpHttpUrl(config.transport.url, { allowLoopbackHttp: this.allowLoopbackHttp });
    }
    const sanitized = sanitizeMcpServerConfig(config);
    this.repos.upsertMcpServer(sanitized, 'registered', []);
    return {
      id: sanitized.id,
      label: sanitized.label,
      enabled: sanitized.enabled,
      transport: sanitized.transport.kind,
      status: 'registered'
    };
  }

  listServers(): MCPServerSummary[] {
    return this.repos.listMcpServers();
  }

  private async openClient(config: MCPServerConfig, signal?: AbortSignal): Promise<DownstreamMcpTransportClient> {
    if (this.clientFactory) {
      return this.clientFactory(config);
    }
    if (config.transport.kind === 'stdio') {
      return StdioSdkTransportClient.connect(config.transport);
    }
    const url = validateMcpHttpUrl(config.transport.url, { allowLoopbackHttp: this.allowLoopbackHttp });
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      const records = await dns.lookup(hostname, { all: true });
      assertSafeResolvedIps(
        hostname,
        records.map((r) => r.address),
        { allowLoopbackHttp: this.allowLoopbackHttp }
      );
    } catch (error) {
      if (error instanceof MindchestraError) {
        throw error;
      }
      throw new MindchestraError('UNAVAILABLE', `Failed to resolve MCP host ${hostname}`, {
        cause: error
      });
    }
    const httpClient = new StreamableHttpMcpClient(url, this.allowLoopbackHttp);
    await httpClient.initialize(signal);
    return httpClient;
  }

  async probeServer(
    serverId: string,
    signal?: AbortSignal
  ): Promise<{ serverId: string; status: string; tools: ToolDescriptor[] }> {
    const server = this.repos.getMcpServer(serverId);
    if (!server) {
      throw new MindchestraError('NOT_FOUND', `MCP server ${serverId} not found`);
    }
    if (!server.config.enabled) {
      this.repos.updateMcpServerDiscovery(serverId, 'disabled', server.tools);
      return { serverId, status: 'disabled', tools: server.tools };
    }

    const previousByName = new Map(server.tools.map((t) => [t.name, t]));
    const client = await this.openClient(server.config, signal);
    try {
      const rawTools = await client.listAllTools(signal);
      const descriptors = rawTools.map((raw) => {
        const schemaHash = computeSchemaHash(raw.inputSchema);
        const existing = previousByName.get(raw.name);
        const access =
          existing && existing.schemaHash === schemaHash ? existing.access : ('unclassified' as const);
        return ToolDescriptorSchema.parse({
          name: raw.name,
          description: redactText(raw.description ?? ''),
          inputSchema: raw.inputSchema,
          schemaHash,
          access
        });
      });

      this.repos.updateMcpServerDiscovery(serverId, 'ready', descriptors);
      return { serverId, status: 'ready', tools: descriptors };
    } catch (error) {
      this.repos.updateMcpServerDiscovery(serverId, 'error', server.tools);
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  listServerTools(serverId: string): ToolDescriptor[] {
    const server = this.repos.getMcpServer(serverId);
    if (!server) {
      throw new MindchestraError('NOT_FOUND', `MCP server ${serverId} not found`);
    }
    return server.tools;
  }

  discoverNamespacedTools(serverId?: string): Array<ToolDescriptor & { serverId: string; qualifiedName: string }> {
    if (serverId) {
      const server = this.repos.getMcpServer(serverId);
      if (!server) {
        throw new MindchestraError('NOT_FOUND', `MCP server ${serverId} not found`);
      }
      return server.tools.map((tool) => ({
        ...tool,
        serverId,
        qualifiedName: `${serverId}::${tool.name}`
      }));
    }

    const summaries = this.repos.listMcpServers();
    const out: Array<ToolDescriptor & { serverId: string; qualifiedName: string }> = [];
    for (const summary of summaries) {
      const full = this.repos.getMcpServer(summary.id);
      if (!full) {
        continue;
      }
      for (const tool of full.tools) {
        out.push({
          ...tool,
          serverId: summary.id,
          qualifiedName: `${summary.id}::${tool.name}`
        });
      }
    }
    return out;
  }

  classifyTool(serverId: string, toolName: string, access: 'unclassified' | 'read' | 'write'): ToolDescriptor {
    const server = this.repos.getMcpServer(serverId);
    if (!server) {
      throw new MindchestraError('NOT_FOUND', `MCP server ${serverId} not found`);
    }
    const idx = server.tools.findIndex((t) => t.name === toolName);
    if (idx < 0) {
      throw new MindchestraError('NOT_FOUND', `Tool ${serverId}::${toolName} not discovered`);
    }
    const updated = ToolDescriptorSchema.parse({
      ...server.tools[idx]!,
      access
    });
    const nextTools = [...server.tools];
    nextTools[idx] = updated;
    this.repos.updateMcpServerDiscovery(serverId, server.status, nextTools);
    return updated;
  }

  async invokeTool(input: {
    caller: CallerIdentity;
    missionId: string;
    runId: string;
    agentId: string;
    profile: Profile;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    grantId?: string;
    approvalId?: string;
    claimId?: string;
    baseCommit?: string;
    correlationId?: string;
    timeoutMs?: number;
  }): Promise<MCPToolInvokeResult> {
    const argsBytes = Buffer.byteLength(JSON.stringify(input.arguments), 'utf8');
    if (argsBytes > MAX_TOOL_ARGS_BYTES) {
      throw new MindchestraError('INVALID_INPUT', 'Tool arguments exceed 256 KiB limit');
    }

    const server = this.repos.getMcpServer(input.serverId);
    if (!server) {
      throw new MindchestraError('NOT_FOUND', `MCP server ${input.serverId} not found`);
    }
    if (!server.config.enabled) {
      throw new MindchestraError('FORBIDDEN', `MCP server ${input.serverId} is disabled`);
    }

    const tool = server.tools.find((t) => t.name === input.toolName);
    if (!tool) {
      throw new MindchestraError('FORBIDDEN', `Unknown tool ${input.serverId}::${input.toolName} denied`);
    }

    const nowIso = new Date().toISOString();
    const correlationId = input.correlationId ?? randomUUID();

    const authDecision = this.policy.authorizeToolCall({
      caller: input.caller,
      missionId: input.missionId,
      runId: input.runId,
      agentId: input.agentId,
      profile: input.profile,
      serverId: input.serverId,
      tool,
      arguments: input.arguments,
      grantId: input.grantId,
      approvalId: input.approvalId,
      baseCommit: input.baseCommit,
      nowIso
    });

    if (authDecision.outcome === 'pending_approval') {
      this.eventStore.appendEvent({
        missionId: input.missionId,
        actor: 'daemon',
        correlationId,
        runId: input.runId,
        at: nowIso,
        payload: {
          type: 'approval.requested',
          payload: authDecision.approvalRequest
        }
      });
      return {
        status: 'pending_approval',
        approvalRequest: authDecision.approvalRequest
      };
    }

    const callId = randomUUID();
    const toolCall = ToolCallSchema.parse({
      id: callId,
      missionId: input.missionId,
      runId: input.runId,
      serverId: input.serverId,
      toolName: input.toolName,
      arguments: redactValue(input.arguments) as Record<string, unknown>,
      schemaHash: tool.schemaHash,
      grantId: authDecision.grant.id,
      ...(authDecision.approval ? { approvalId: authDecision.approval.id } : {})
    });

    this.repos.insertToolCall(toolCall, 'pending', nowIso);
    this.eventStore.appendEvent({
      missionId: input.missionId,
      actor: input.agentId,
      correlationId,
      runId: input.runId,
      at: nowIso,
      payload: {
        type: 'tool.called',
        payload: toolCall
      }
    });

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort(new MindchestraError('TIMEOUT', 'Downstream MCP tool call timed out'));
    }, timeoutMs);

    const client = await this.openClient(server.config, timeoutController.signal);
    try {
      const response = await client.callTool(input.toolName, input.arguments, timeoutController.signal);
      const redactedText = redactText(response.text);
      const artifact = this.artifacts.putArtifact({
        missionId: input.missionId,
        contentType: 'application/json',
        content: JSON.stringify(
          {
            serverId: input.serverId,
            toolName: input.toolName,
            text: redactedText,
            raw: redactValue(response.raw)
          },
          null,
          2
        )
      });

      if (input.claimId) {
        const evidence: EvidenceRef = EvidenceRefSchema.parse({
          id: randomUUID(),
          missionId: input.missionId,
          claimId: input.claimId,
          kind: 'tool',
          relation: 'supports',
          sourceRef: `mcp://${input.serverId}/${input.toolName}`,
          artifactId: artifact.id,
          sha256: artifact.sha256,
          ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
          at: new Date().toISOString(),
          provenance: 'gateway',
          status: response.isError ? 'rejected' : 'verified'
        });
        this.repos.insertEvidence(evidence);
        this.eventStore.appendEvent({
          missionId: input.missionId,
          actor: 'daemon',
          correlationId,
          runId: input.runId,
          at: evidence.at,
          payload: {
            type: 'evidence.added',
            payload: evidence
          }
        });
      }

      const result = ToolResultSchema.parse({
        callId,
        status: response.isError ? 'error' : 'ok',
        artifactIds: [artifact.id],
        summary: redactedText.slice(0, 1000) || `Executed ${input.serverId}::${input.toolName}`,
        ...(response.isError
          ? {
              error: {
                code: 'INTERNAL',
                message: redactedText.slice(0, 500) || 'Downstream MCP tool returned error',
                retryable: false
              }
            }
          : {})
      });

      this.repos.completeToolCall(result, new Date().toISOString());
      this.eventStore.appendEvent({
        missionId: input.missionId,
        actor: 'daemon',
        correlationId,
        runId: input.runId,
        at: new Date().toISOString(),
        payload: {
          type: 'tool.completed',
          payload: result
        }
      });
      return result;
    } catch (error) {
      const timedOut = timeoutController.signal.aborted;
      const status: ToolResult['status'] =
        tool.access === 'write' ? 'unknown_outcome' : timedOut ? 'timeout' : 'error';
      const errCode = status === 'unknown_outcome' ? 'UNKNOWN_OUTCOME' : timedOut ? 'TIMEOUT' : 'INTERNAL';
      const message = redactText(error instanceof Error ? error.message : 'Downstream tool execution failed');
      const result = ToolResultSchema.parse({
        callId,
        status,
        artifactIds: [],
        summary: message.slice(0, 1000),
        error: {
          code: errCode,
          message: message.slice(0, 500),
          retryable: false
        }
      });
      this.repos.completeToolCall(result, new Date().toISOString());
      this.eventStore.appendEvent({
        missionId: input.missionId,
        actor: 'daemon',
        correlationId,
        runId: input.runId,
        at: new Date().toISOString(),
        payload: {
          type: 'tool.completed',
          payload: result
        }
      });
      return result;
    } finally {
      clearTimeout(timeoutHandle);
      await client.close().catch(() => undefined);
    }
  }
}
