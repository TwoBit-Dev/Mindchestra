import {
  ErrorEnvelopeSchema,
  MindchestraError,
  type AgentSummary,
  type ApprovalRequest,
  type EvidenceRelation,
  type MCPToolInvokeResult,
  type MissionResult,
  type MissionSnapshot,
  type MissionSpec,
  type ProbeResult,
  type ToolDescriptor
} from '@mindchestra/contracts';
import type { CallerIdentity } from '@mindchestra/policy';

export interface DaemonMcpBackend {
  startMission(caller: CallerIdentity, spec: MissionSpec, idempotencyKey?: string): Promise<MissionSnapshot>;
  getMissionStatus(caller: CallerIdentity, missionId: string): Promise<MissionSnapshot>;
  getMissionResult(caller: CallerIdentity, missionId: string): Promise<MissionResult>;
  cancelMission(caller: CallerIdentity, missionId: string): Promise<MissionSnapshot>;
  listAgents(caller: CallerIdentity): Promise<{ items: AgentSummary[] }>;
  probeAgent(caller: CallerIdentity, agentId: string): Promise<ProbeResult>;
  sendAgentMessage(
    caller: CallerIdentity,
    input: { missionId: string; recipientAgentId: string; text: string; relatedClaimIds: string[] }
  ): Promise<{ messageId: string }>;
  submitEvidence(
    caller: CallerIdentity,
    input: {
      missionId: string;
      claimId: string;
      sourceRef: string;
      relation: EvidenceRelation;
      artifactId?: string;
    }
  ): Promise<{ evidenceId: string }>;
  discoverTools(caller: CallerIdentity, serverId?: string): Promise<ToolDescriptor[]>;
  invokeTool(
    caller: CallerIdentity,
    input: {
      missionId: string;
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      claimId?: string;
    }
  ): Promise<MCPToolInvokeResult>;
  listApprovals(caller: CallerIdentity, missionId: string): Promise<ApprovalRequest[]>;
}

export class HttpDaemonMcpBackend implements DaemonMcpBackend {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly authToken: string
  ) {
    const parsed = new URL(baseUrl);
    if (
      parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '::1' &&
      parsed.hostname !== '[::1]'
    ) {
      throw new MindchestraError('FORBIDDEN', 'Daemon MCP client only permits loopback endpoints');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.authToken}`,
      accept: 'application/json',
      ...extraHeaders
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    const json = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const parsedErr = ErrorEnvelopeSchema.safeParse(json);
      if (parsedErr.success) {
        throw new MindchestraError(parsedErr.data.error.code, parsedErr.data.error.message, {
          retryable: parsedErr.data.error.retryable,
          details: parsedErr.data.error.details
        });
      }
      throw new MindchestraError('INTERNAL', `Daemon returned HTTP ${res.status}`);
    }

    return json as T;
  }

  async startMission(_caller: CallerIdentity, spec: MissionSpec, idempotencyKey?: string): Promise<MissionSnapshot> {
    return this.request<MissionSnapshot>(
      'POST',
      '/v1/missions',
      spec,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined
    );
  }

  async getMissionStatus(_caller: CallerIdentity, missionId: string): Promise<MissionSnapshot> {
    return this.request<MissionSnapshot>('GET', `/v1/missions/${encodeURIComponent(missionId)}`);
  }

  async getMissionResult(_caller: CallerIdentity, missionId: string): Promise<MissionResult> {
    return this.request<MissionResult>('GET', `/v1/missions/${encodeURIComponent(missionId)}/result`);
  }

  async cancelMission(_caller: CallerIdentity, missionId: string): Promise<MissionSnapshot> {
    return this.request<MissionSnapshot>('POST', `/v1/missions/${encodeURIComponent(missionId)}/cancel`, {});
  }

  async listAgents(_caller: CallerIdentity): Promise<{ items: AgentSummary[] }> {
    return this.request<{ items: AgentSummary[] }>('GET', '/v1/agents');
  }

  async probeAgent(_caller: CallerIdentity, agentId: string): Promise<ProbeResult> {
    return this.request<ProbeResult>('POST', `/v1/agents/${encodeURIComponent(agentId)}/probe`, {});
  }

  async sendAgentMessage(
    _caller: CallerIdentity,
    input: { missionId: string; recipientAgentId: string; text: string; relatedClaimIds: string[] }
  ): Promise<{ messageId: string }> {
    return this.request<{ messageId: string }>(
      'POST',
      `/v1/missions/${encodeURIComponent(input.missionId)}/messages`,
      {
        recipientAgentId: input.recipientAgentId,
        text: input.text,
        relatedClaimIds: input.relatedClaimIds
      }
    );
  }

  async submitEvidence(
    _caller: CallerIdentity,
    input: {
      missionId: string;
      claimId: string;
      sourceRef: string;
      relation: EvidenceRelation;
      artifactId?: string;
    }
  ): Promise<{ evidenceId: string }> {
    return this.request<{ evidenceId: string }>(
      'POST',
      `/v1/missions/${encodeURIComponent(input.missionId)}/evidence`,
      {
        claimId: input.claimId,
        sourceRef: input.sourceRef,
        relation: input.relation,
        ...(input.artifactId ? { artifactId: input.artifactId } : {})
      }
    );
  }

  async discoverTools(_caller: CallerIdentity, serverId?: string): Promise<ToolDescriptor[]> {
    const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
    const res = await this.request<{ items: ToolDescriptor[] }>('GET', `/v1/mcp/tools/discover${query}`);
    return res.items;
  }

  async invokeTool(
    _caller: CallerIdentity,
    input: {
      missionId: string;
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      claimId?: string;
    }
  ): Promise<MCPToolInvokeResult> {
    return this.request<MCPToolInvokeResult>('POST', '/v1/mcp/tools/invoke', input);
  }

  async listApprovals(_caller: CallerIdentity, missionId: string): Promise<ApprovalRequest[]> {
    const res = await this.request<{ items: ApprovalRequest[] }>(
      'GET',
      `/v1/approvals?missionId=${encodeURIComponent(missionId)}`
    );
    return res.items;
  }
}
