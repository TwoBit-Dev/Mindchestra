import { randomUUID } from 'node:crypto';
import {
  ApprovalRequestSchema,
  MindchestraError,
  type ApprovalRequest,
  type Profile,
  type ToolDescriptor,
  type ToolGrant
} from '@mindchestra/contracts';
import type { StorageRepositories } from '@mindchestra/storage';
import { buildToolActionHash } from './action-hash.js';
import type { CallerIdentity } from './recursive-guard.js';

export interface ToolAuthorizationInput {
  caller: CallerIdentity;
  missionId: string;
  runId: string;
  agentId: string;
  profile: Profile;
  serverId: string;
  tool: ToolDescriptor;
  arguments: Record<string, unknown>;
  grantId?: string;
  approvalId?: string;
  baseCommit?: string;
  nowIso?: string;
}

export type ToolAuthorizationDecision =
  | {
      outcome: 'allow';
      grant: ToolGrant;
      approval?: ApprovalRequest;
    }
  | {
      outcome: 'pending_approval';
      approvalRequest: ApprovalRequest;
    };

export interface PolicyEngineOptions {
  allowLiveWrites?: boolean;
  approvalTtlMs?: number;
}

export class PolicyEngine {
  private readonly allowLiveWrites: boolean;
  private readonly approvalTtlMs: number;

  constructor(
    private readonly repos: StorageRepositories,
    options?: PolicyEngineOptions
  ) {
    this.allowLiveWrites = options?.allowLiveWrites ?? false;
    this.approvalTtlMs = options?.approvalTtlMs ?? 15 * 60 * 1000;
  }

  get isLiveWriteEnabled(): boolean {
    return this.allowLiveWrites;
  }

  authorizeToolCall(input: ToolAuthorizationInput): ToolAuthorizationDecision {
    const nowIso = input.nowIso ?? new Date().toISOString();

    if (input.caller.missionId !== undefined && input.caller.missionId !== input.missionId) {
      throw new MindchestraError('FORBIDDEN', 'Caller mission scope mismatch');
    }

    if (input.tool.access === 'unclassified') {
      throw new MindchestraError(
        'FORBIDDEN',
        `Tool ${input.serverId}::${input.tool.name} is unclassified and denied by default policy`
      );
    }

    const grant = this.resolveGrant(input);

    if (grant.schemaHash !== input.tool.schemaHash) {
      throw new MindchestraError(
        'FORBIDDEN',
        `Schema hash drift detected for ${input.serverId}::${input.tool.name}; grant invalidated`
      );
    }

    if (grant.agentId !== input.agentId || grant.missionId !== input.missionId || grant.serverId !== input.serverId) {
      throw new MindchestraError('FORBIDDEN', 'Tool grant scope does not match caller');
    }

    if (input.tool.access === 'write') {
      if (input.profile === 'read-only') {
        throw new MindchestraError('FORBIDDEN', 'Write tool execution is forbidden under read-only profile');
      }
      if (grant.access !== 'write') {
        throw new MindchestraError('FORBIDDEN', 'Read grant cannot authorize a write tool');
      }

      const actionHash = buildToolActionHash({
        missionId: input.missionId,
        runId: input.runId,
        action: 'tool_write',
        target: `${input.serverId}::${input.tool.name}`,
        argumentsOrPatch: input.arguments,
        schemaHash: input.tool.schemaHash,
        baseCommit: input.baseCommit
      });

      if (!input.approvalId) {
        const createdAt = nowIso;
        const expiresAt = new Date(new Date(nowIso).getTime() + this.approvalTtlMs).toISOString();
        const approvalRequest = ApprovalRequestSchema.parse({
          id: randomUUID(),
          missionId: input.missionId,
          runId: input.runId,
          action: 'tool_write',
          target: `${input.serverId}::${input.tool.name}`,
          risk: 'high',
          summary: `Execute write tool ${input.serverId}::${input.tool.name}`,
          actionHash,
          createdAt,
          expiresAt,
          status: 'pending'
        });
        this.repos.insertApprovalRequest(approvalRequest);
        return {
          outcome: 'pending_approval',
          approvalRequest
        };
      }

      if (!this.allowLiveWrites) {
        throw new MindchestraError('FORBIDDEN', 'Live write tool execution is disabled in v0.1');
      }

      const consumedApproval = this.repos.consumeApprovedApprovalAtomic(input.approvalId, actionHash, nowIso);
      const consumedGrant = this.repos.consumeToolGrantQuota(grant.id, input.tool.schemaHash, nowIso);
      return {
        outcome: 'allow',
        grant: consumedGrant,
        approval: consumedApproval
      };
    }

    const consumedGrant = this.repos.consumeToolGrantQuota(grant.id, input.tool.schemaHash, nowIso);
    return {
      outcome: 'allow',
      grant: consumedGrant
    };
  }

  private resolveGrant(input: ToolAuthorizationInput): ToolGrant {
    if (input.grantId) {
      const explicit = this.repos.getToolGrant(input.grantId);
      if (!explicit) {
        throw new MindchestraError('FORBIDDEN', `Tool grant ${input.grantId} not found`);
      }
      return explicit;
    }

    const matched = this.repos.findMatchingToolGrant({
      missionId: input.missionId,
      agentId: input.agentId,
      serverId: input.serverId,
      toolName: input.tool.name
    });

    if (!matched) {
      throw new MindchestraError(
        'FORBIDDEN',
        `No active tool grant for ${input.agentId} on ${input.serverId}::${input.tool.name}`
      );
    }

    return matched.grant;
  }
}
