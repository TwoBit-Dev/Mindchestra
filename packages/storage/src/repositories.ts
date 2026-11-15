import { randomUUID } from 'node:crypto';
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ClaimSchema,
  EvidenceRefSchema,
  MCPServerConfigSchema,
  MindchestraError,
  MissionResultSchema,
  MissionSnapshotSchema,
  MissionSpecSchema,
  ToolCallSchema,
  ToolDescriptorSchema,
  ToolGrantSchema,
  ToolResultSchema,
  UsageMetricsSchema,
  VerdictSchema,
  AgentConfigSchema,
  AgentMessageSchema,
  ProbeResultSchema,
  type AgentConfig,
  type AgentEvent,
  type AgentMessage,
  type ApprovalDecision,
  type ApprovalInput,
  type ApprovalRequest,
  type ApprovalStatus,
  type Claim,
  type ClaimStatus,
  type EvidenceRef,
  type EvidenceStatus,
  type MCPServerConfig,
  type MCPServerSummary,
  type MissionResult,
  type MissionSnapshot,
  type MissionSpec,
  type MissionStatus,
  type PaginatedResponse,
  type Phase,
  type ProbeResult,
  type ToolCall,
  type ToolDescriptor,
  type ToolGrant,
  type ToolResult,
  type UsageMetrics,
  type Verdict,
  type WorkspaceSummary
} from '@mindchestra/contracts';
import type { SqliteDatabase } from './database.js';
import type { AppendEventInput, ChainVerificationResult, EventStore } from './event-store.js';

export interface RunRecord {
  id: string;
  missionId: string;
  agentId: string;
  phase: Phase;
  status: 'running' | 'finished' | 'failed' | 'cancelled' | 'interrupted';
  sessionId?: string;
  usage?: UsageMetrics;
  summary?: string;
  startedAt: string;
  endedAt?: string;
}

export interface WorkspaceRecord {
  id: string;
  label: string;
  canonicalPath: string;
  createdAt: string;
}

export interface RecoveryReport {
  interruptedMissions: string[];
  interruptedRuns: string[];
  unknownOutcomeToolCalls: string[];
}

interface MissionRow {
  id: string;
  spec_json: string;
  status: MissionStatus;
  phase: Phase;
  base_commit: string | null;
  parent_mission_id: string | null;
  last_seq: number;
  result_json: string | null;
  pending_approval_ids_json: string;
  created_at: string;
  updated_at: string;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    throw new MindchestraError('INVALID_INPUT', 'Invalid pagination cursor');
  }
  throw new MindchestraError('INVALID_INPUT', 'Invalid pagination cursor');
}

function clampLimit(limit?: number): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new MindchestraError('INVALID_INPUT', 'limit must be an integer between 1 and 200');
  }
  return limit;
}

function mapMissionRow(row: MissionRow): MissionSnapshot {
  const snapshot: MissionSnapshot = {
    id: row.id,
    spec: MissionSpecSchema.parse(JSON.parse(row.spec_json)),
    status: row.status,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeq: row.last_seq,
    resultAvailable: row.result_json !== null,
    pendingApprovalIds: JSON.parse(row.pending_approval_ids_json) as string[]
  };
  if (row.base_commit !== null) {
    snapshot.baseCommit = row.base_commit;
  }
  if (row.parent_mission_id !== null) {
    snapshot.parentMissionId = row.parent_mission_id;
  }
  return MissionSnapshotSchema.parse(snapshot);
}

export class StorageRepositories {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly eventStore: EventStore
  ) {}

  appendEvent(input: AppendEventInput): AgentEvent {
    return this.eventStore.appendEvent(input);
  }

  listEventsAfter(missionId: string, afterSeq = 0, limit = 1000): AgentEvent[] {
    return this.eventStore.listEventsAfter(missionId, afterSeq, limit);
  }

  verifyEventChain(missionId: string): ChainVerificationResult {
    return this.eventStore.verifyEventChain(missionId);
  }

  findIdempotentMission(
    callerScope: string,
    idempotencyKey: string,
    requestHash: string
  ): MissionSnapshot | undefined {
    const existingKey = this.db.connection
      .prepare('SELECT request_hash, mission_id FROM idempotency_keys WHERE caller_scope = ? AND idempotency_key = ?')
      .get(callerScope, idempotencyKey) as
      | { request_hash: string; mission_id: string }
      | undefined;

    if (!existingKey) {
      return undefined;
    }

    if (existingKey.request_hash !== requestHash) {
      throw new MindchestraError(
        'CONFLICT',
        'Idempotency-Key was already used with a different request payload'
      );
    }

    return this.getMissionSnapshot(existingKey.mission_id);
  }

  createMissionWithIdempotency(input: {
    missionId?: string;
    spec: MissionSpec;
    callerScope: string;
    idempotencyKey?: string;
    requestHash: string;
    correlationId: string;
    baseCommit?: string;
    parentMissionId?: string;
    nowIso?: string;
  }): { snapshot: MissionSnapshot; deduplicated: boolean } {
    return this.db.transaction(() => {
      if (input.idempotencyKey !== undefined) {
        const existingKey = this.db.connection
          .prepare('SELECT request_hash, mission_id FROM idempotency_keys WHERE caller_scope = ? AND idempotency_key = ?')
          .get(input.callerScope, input.idempotencyKey) as
          | { request_hash: string; mission_id: string }
          | undefined;

        if (existingKey) {
          if (existingKey.request_hash !== input.requestHash) {
            throw new MindchestraError(
              'CONFLICT',
              'Idempotency-Key was already used with a different request payload'
            );
          }
          const existingMission = this.getMissionSnapshot(existingKey.mission_id);
          return { snapshot: existingMission, deduplicated: true };
        }
      }

      const id = input.missionId ?? randomUUID();
      const now = input.nowIso ?? new Date().toISOString();

      this.db.connection
        .prepare(
          `INSERT INTO missions (
            id, spec_json, status, phase, base_commit, parent_mission_id, last_seq, retained_from_seq,
            result_json, pending_approval_ids_json, created_at, updated_at
          ) VALUES (?, ?, 'queued', 'prepare', ?, ?, 0, 1, NULL, '[]', ?, ?)`
        )
        .run(
          id,
          JSON.stringify(input.spec),
          input.baseCommit ?? null,
          input.parentMissionId ?? null,
          now,
          now
        );

      if (input.idempotencyKey !== undefined) {
        this.db.connection
          .prepare(
            `INSERT INTO idempotency_keys (caller_scope, idempotency_key, request_hash, mission_id, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(input.callerScope, input.idempotencyKey, input.requestHash, id, now);
      }

      this.eventStore.appendEvent({
        missionId: id,
        actor: 'daemon',
        correlationId: input.correlationId,
        at: now,
        payload: {
          type: 'mission.created',
          payload: { spec: input.spec }
        }
      });

      return {
        snapshot: this.getMissionSnapshot(id),
        deduplicated: false
      };
    });
  }

  getMissionSnapshot(missionId: string): MissionSnapshot {
    const row = this.db.connection
      .prepare('SELECT * FROM missions WHERE id = ?')
      .get(missionId) as MissionRow | undefined;

    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Mission ${missionId} not found`);
    }
    return mapMissionRow(row);
  }

  listMissions(options?: {
    cursor?: string;
    limit?: number;
    status?: MissionStatus;
  }): PaginatedResponse<MissionSnapshot> {
    const offset = decodeCursor(options?.cursor);
    const limit = clampLimit(options?.limit);

    const rows = options?.status
      ? (this.db.connection
          .prepare(
            `SELECT * FROM missions WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
          )
          .all(options.status, limit + 1, offset) as MissionRow[])
      : (this.db.connection
          .prepare(`SELECT * FROM missions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(limit + 1, offset) as MissionRow[]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map(mapMissionRow),
      nextCursor: hasMore ? encodeCursor(offset + limit) : null
    };
  }

  getMissionResult(missionId: string): MissionResult {
    const row = this.db.connection
      .prepare('SELECT result_json FROM missions WHERE id = ?')
      .get(missionId) as { result_json: string | null } | undefined;

    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Mission ${missionId} not found`);
    }
    if (!row.result_json) {
      throw new MindchestraError('NOT_READY', 'Mission result is not ready yet', {
        retryable: true
      });
    }
    return MissionResultSchema.parse(JSON.parse(row.result_json));
  }

  insertRun(run: RunRecord): void {
    this.db.connection
      .prepare(
        `INSERT INTO runs (id, mission_id, agent_id, phase, status, session_id, usage_json, summary, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.missionId,
        run.agentId,
        run.phase,
        run.status,
        run.sessionId ?? null,
        run.usage ? JSON.stringify(run.usage) : null,
        run.summary ?? null,
        run.startedAt,
        run.endedAt ?? null
      );
  }

  updateRun(runId: string, update: {
    status?: RunRecord['status'];
    sessionId?: string;
    usage?: UsageMetrics;
    summary?: string;
    endedAt?: string;
  }): void {
    const existing = this.db.connection
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(runId) as
      | {
          status: RunRecord['status'];
          session_id: string | null;
          usage_json: string | null;
          summary: string | null;
          ended_at: string | null;
        }
      | undefined;

    if (!existing) {
      throw new MindchestraError('NOT_FOUND', `Run ${runId} not found`);
    }

    this.db.connection
      .prepare(
        `UPDATE runs
         SET status = ?, session_id = ?, usage_json = ?, summary = ?, ended_at = ?
         WHERE id = ?`
      )
      .run(
        update.status ?? existing.status,
        update.sessionId ?? existing.session_id,
        update.usage ? JSON.stringify(update.usage) : existing.usage_json,
        update.summary ?? existing.summary,
        update.endedAt ?? existing.ended_at,
        runId
      );
  }

  listRunsByMission(missionId: string): RunRecord[] {
    const rows = this.db.connection
      .prepare('SELECT * FROM runs WHERE mission_id = ? ORDER BY started_at ASC')
      .all(missionId) as Array<{
      id: string;
      mission_id: string;
      agent_id: string;
      phase: Phase;
      status: RunRecord['status'];
      session_id: string | null;
      usage_json: string | null;
      summary: string | null;
      started_at: string;
      ended_at: string | null;
    }>;

    return rows.map((row) => {
      const record: RunRecord = {
        id: row.id,
        missionId: row.mission_id,
        agentId: row.agent_id,
        phase: row.phase,
        status: row.status,
        startedAt: row.started_at
      };
      if (row.session_id !== null) {
        record.sessionId = row.session_id;
      }
      if (row.usage_json !== null) {
        record.usage = UsageMetricsSchema.parse(JSON.parse(row.usage_json));
      }
      if (row.summary !== null) {
        record.summary = row.summary;
      }
      if (row.ended_at !== null) {
        record.endedAt = row.ended_at;
      }
      return record;
    });
  }

  countActiveRunsForAgent(agentId: string): number {
    const row = this.db.connection
      .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE agent_id = ? AND status = 'running'")
      .get(agentId) as { cnt: number };
    return row.cnt;
  }

  insertClaim(claim: Claim, createdAt = new Date().toISOString()): void {
    const valid = ClaimSchema.parse(claim);
    this.db.connection
      .prepare(
        `INSERT INTO claims (id, mission_id, run_id, severity, status, supersedes_id, confidence, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.runId,
        valid.severity,
        valid.status,
        valid.supersedesId ?? null,
        valid.confidence ?? null,
        JSON.stringify(valid),
        createdAt
      );
  }

  updateClaimStatus(claimId: string, status: ClaimStatus): void {
    const row = this.db.connection
      .prepare('SELECT payload_json FROM claims WHERE id = ?')
      .get(claimId) as { payload_json: string } | undefined;
    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Claim ${claimId} not found`);
    }
    const updated = ClaimSchema.parse({
      ...JSON.parse(row.payload_json),
      status
    });
    this.db.connection
      .prepare('UPDATE claims SET status = ?, payload_json = ? WHERE id = ?')
      .run(status, JSON.stringify(updated), claimId);
  }

  listClaimsByMission(missionId: string): Claim[] {
    const rows = this.db.connection
      .prepare('SELECT payload_json FROM claims WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as Array<{ payload_json: string }>;
    return rows.map((row) => ClaimSchema.parse(JSON.parse(row.payload_json)));
  }

  insertEvidence(evidence: EvidenceRef): void {
    const valid = EvidenceRefSchema.parse(evidence);
    this.db.connection
      .prepare(
        `INSERT INTO evidence (
          id, mission_id, claim_id, kind, relation, source_ref, artifact_id, sha256, provenance, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.claimId,
        valid.kind,
        valid.relation,
        valid.sourceRef,
        valid.artifactId ?? null,
        valid.sha256 ?? null,
        valid.provenance,
        valid.status,
        JSON.stringify(valid),
        valid.at
      );
  }

  updateEvidenceStatus(evidenceId: string, status: EvidenceStatus): void {
    const row = this.db.connection
      .prepare('SELECT payload_json FROM evidence WHERE id = ?')
      .get(evidenceId) as { payload_json: string } | undefined;
    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Evidence ${evidenceId} not found`);
    }
    const updated = EvidenceRefSchema.parse({
      ...JSON.parse(row.payload_json),
      status
    });
    this.db.connection
      .prepare('UPDATE evidence SET status = ?, payload_json = ? WHERE id = ?')
      .run(status, JSON.stringify(updated), evidenceId);
  }

  listEvidenceByMission(missionId: string): EvidenceRef[] {
    const rows = this.db.connection
      .prepare('SELECT payload_json FROM evidence WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as Array<{ payload_json: string }>;
    return rows.map((row) => EvidenceRefSchema.parse(JSON.parse(row.payload_json)));
  }

  insertVerdict(verdict: Verdict, createdAt = new Date().toISOString()): void {
    const valid = VerdictSchema.parse(verdict);
    this.db.connection
      .prepare(
        `INSERT INTO verdicts (id, mission_id, status, rubric_id, score, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.status,
        valid.rubricId,
        valid.score ?? null,
        JSON.stringify(valid),
        createdAt
      );
  }

  listVerdictsByMission(missionId: string): Verdict[] {
    const rows = this.db.connection
      .prepare('SELECT payload_json FROM verdicts WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as Array<{ payload_json: string }>;
    return rows.map((row) => VerdictSchema.parse(JSON.parse(row.payload_json)));
  }

  insertMessage(message: AgentMessage): void {
    const valid = AgentMessageSchema.parse(message);
    this.db.connection
      .prepare(
        `INSERT INTO messages (id, mission_id, sender_run_id, recipient_agent_id, phase, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.senderRunId,
        valid.recipientAgentId,
        valid.phase,
        JSON.stringify(valid),
        valid.at
      );
  }

  listMessagesByMission(missionId: string): AgentMessage[] {
    const rows = this.db.connection
      .prepare('SELECT payload_json FROM messages WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as Array<{ payload_json: string }>;
    return rows.map((row) => AgentMessageSchema.parse(JSON.parse(row.payload_json)));
  }

  insertApprovalRequest(request: ApprovalRequest): void {
    const valid = ApprovalRequestSchema.parse(request);
    this.db.connection
      .prepare(
        `INSERT INTO approvals (
          id, mission_id, run_id, action, target, risk, action_hash, status, expires_at, consumed_at, decision_json, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.runId ?? null,
        valid.action,
        valid.target,
        valid.risk,
        valid.actionHash,
        valid.status,
        valid.expiresAt,
        JSON.stringify(valid),
        valid.createdAt
      );
  }

  getApprovalRequest(approvalId: string): ApprovalRequest {
    const row = this.db.connection
      .prepare('SELECT payload_json FROM approvals WHERE id = ?')
      .get(approvalId) as { payload_json: string } | undefined;
    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Approval request ${approvalId} not found`);
    }
    return ApprovalRequestSchema.parse(JSON.parse(row.payload_json));
  }

  listApprovals(options?: { missionId?: string; status?: ApprovalStatus }): ApprovalRequest[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (options?.missionId) {
      conditions.push('mission_id = ?');
      params.push(options.missionId);
    }
    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.connection
      .prepare(`SELECT payload_json FROM approvals ${whereClause} ORDER BY created_at DESC`)
      .all(...params) as Array<{ payload_json: string }>;
    return rows.map((row) => ApprovalRequestSchema.parse(JSON.parse(row.payload_json)));
  }

  decideApprovalAtomic(
    approvalId: string,
    input: ApprovalInput,
    decidedBy: string,
    nowIso = new Date().toISOString()
  ): { request: ApprovalRequest; decision: ApprovalDecision } {
    return this.db.transaction(() => {
      const row = this.db.connection
        .prepare('SELECT payload_json, status, expires_at, action_hash FROM approvals WHERE id = ?')
        .get(approvalId) as
        | { payload_json: string; status: ApprovalStatus; expires_at: string; action_hash: string }
        | undefined;

      if (!row) {
        throw new MindchestraError('NOT_FOUND', `Approval request ${approvalId} not found`);
      }

      const existing = ApprovalRequestSchema.parse(JSON.parse(row.payload_json));

      if (existing.expiresAt <= nowIso && existing.status === 'pending') {
        const expiredReq = ApprovalRequestSchema.parse({ ...existing, status: 'expired' });
        this.db.connection
          .prepare("UPDATE approvals SET status = 'expired', payload_json = ? WHERE id = ?")
          .run(JSON.stringify(expiredReq), approvalId);
        throw new MindchestraError('CONFLICT', 'Approval request has expired');
      }

      if (existing.status !== 'pending') {
        throw new MindchestraError('CONFLICT', `Approval request is already ${existing.status}`);
      }

      if (existing.actionHash !== input.actionHash) {
        throw new MindchestraError('CONFLICT', 'Approval actionHash does not match pending request');
      }

      const nextStatus: ApprovalStatus = input.decision === 'approve' ? 'approved' : 'denied';
      const updatedReq = ApprovalRequestSchema.parse({
        ...existing,
        status: nextStatus
      });
      const decision = ApprovalDecisionSchema.parse({
        ...input,
        approvalId,
        decidedAt: nowIso,
        decidedBy
      });

      this.db.connection
        .prepare('UPDATE approvals SET status = ?, decision_json = ?, payload_json = ? WHERE id = ?')
        .run(nextStatus, JSON.stringify(decision), JSON.stringify(updatedReq), approvalId);

      return { request: updatedReq, decision };
    });
  }

  consumeApprovedApprovalAtomic(
    approvalId: string,
    expectedActionHash: string,
    nowIso = new Date().toISOString()
  ): ApprovalRequest {
    return this.db.transaction(() => {
      const row = this.db.connection
        .prepare('SELECT payload_json FROM approvals WHERE id = ?')
        .get(approvalId) as { payload_json: string } | undefined;
      if (!row) {
        throw new MindchestraError('NOT_FOUND', `Approval request ${approvalId} not found`);
      }
      const existing = ApprovalRequestSchema.parse(JSON.parse(row.payload_json));
      if (existing.expiresAt <= nowIso) {
        const expired = ApprovalRequestSchema.parse({ ...existing, status: 'expired' });
        this.db.connection
          .prepare("UPDATE approvals SET status = 'expired', payload_json = ? WHERE id = ?")
          .run(JSON.stringify(expired), approvalId);
        throw new MindchestraError('CONFLICT', 'Approval request has expired');
      }
      if (existing.status !== 'approved') {
        throw new MindchestraError('FORBIDDEN', `Approval ${approvalId} is ${existing.status}, expected approved`);
      }
      if (existing.actionHash !== expectedActionHash) {
        throw new MindchestraError('CONFLICT', 'Approval actionHash mismatch');
      }
      const consumed = ApprovalRequestSchema.parse({ ...existing, status: 'consumed' });
      this.db.connection
        .prepare("UPDATE approvals SET status = 'consumed', consumed_at = ?, payload_json = ? WHERE id = ?")
        .run(nowIso, JSON.stringify(consumed), approvalId);
      return consumed;
    });
  }

  insertToolGrant(grant: ToolGrant): void {
    const valid = ToolGrantSchema.parse(grant);
    this.db.connection
      .prepare(
        `INSERT INTO tool_grants (
          id, mission_id, agent_id, server_id, tool_name, schema_hash, access, expires_at, max_calls, calls_used, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.agentId,
        valid.serverId,
        valid.toolName,
        valid.schemaHash,
        valid.access,
        valid.expiresAt,
        valid.maxCalls,
        JSON.stringify(valid)
      );
  }

  getToolGrant(grantId: string): ToolGrant | undefined {
    const row = this.db.connection
      .prepare('SELECT payload_json FROM tool_grants WHERE id = ?')
      .get(grantId) as { payload_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return ToolGrantSchema.parse(JSON.parse(row.payload_json));
  }

  findMatchingToolGrant(params: {
    missionId: string;
    agentId: string;
    serverId: string;
    toolName: string;
  }): { grant: ToolGrant; callsUsed: number } | undefined {
    const row = this.db.connection
      .prepare(
        `SELECT payload_json, calls_used FROM tool_grants
         WHERE mission_id = ? AND agent_id = ? AND server_id = ? AND tool_name = ?
         ORDER BY expires_at DESC LIMIT 1`
      )
      .get(params.missionId, params.agentId, params.serverId, params.toolName) as
      | { payload_json: string; calls_used: number }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      grant: ToolGrantSchema.parse(JSON.parse(row.payload_json)),
      callsUsed: row.calls_used
    };
  }

  consumeToolGrantQuota(grantId: string, expectedSchemaHash: string, nowIso = new Date().toISOString()): ToolGrant {
    return this.db.transaction(() => {
      const row = this.db.connection
        .prepare('SELECT payload_json, calls_used FROM tool_grants WHERE id = ?')
        .get(grantId) as { payload_json: string; calls_used: number } | undefined;

      if (!row) {
        throw new MindchestraError('FORBIDDEN', `No grant found for ${grantId}`);
      }
      const grant = ToolGrantSchema.parse(JSON.parse(row.payload_json));
      if (grant.schemaHash !== expectedSchemaHash) {
        throw new MindchestraError('FORBIDDEN', 'Tool schema hash drift invalidated existing grant');
      }
      if (grant.expiresAt <= nowIso) {
        throw new MindchestraError('FORBIDDEN', 'Tool grant has expired');
      }
      if (row.calls_used >= grant.maxCalls) {
        throw new MindchestraError('FORBIDDEN', 'Tool grant call quota exceeded');
      }

      this.db.connection
        .prepare('UPDATE tool_grants SET calls_used = calls_used + 1 WHERE id = ?')
        .run(grantId);

      return grant;
    });
  }

  insertToolCall(call: ToolCall, status: ToolResult['status'] | 'pending', nowIso = new Date().toISOString()): void {
    const valid = ToolCallSchema.parse(call);
    this.db.connection
      .prepare(
        `INSERT INTO tool_calls (
          id, mission_id, run_id, server_id, tool_name, grant_id, approval_id, status, payload_json, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        valid.id,
        valid.missionId,
        valid.runId,
        valid.serverId,
        valid.toolName,
        valid.grantId,
        valid.approvalId ?? null,
        status,
        JSON.stringify(valid),
        nowIso,
        nowIso
      );
  }

  completeToolCall(result: ToolResult, nowIso = new Date().toISOString()): void {
    const valid = ToolResultSchema.parse(result);
    this.db.connection
      .prepare('UPDATE tool_calls SET status = ?, result_json = ?, updated_at = ? WHERE id = ?')
      .run(valid.status, JSON.stringify(valid), nowIso, valid.callId);
  }

  upsertAgentConfig(config: AgentConfig, nowIso = new Date().toISOString()): void {
    const valid = AgentConfigSchema.parse(config);
    this.db.connection
      .prepare(
        `INSERT INTO agent_configs (id, adapter_id, config_json, probe_json, updated_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           adapter_id = excluded.adapter_id,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`
      )
      .run(valid.id, valid.adapterId, JSON.stringify(valid), nowIso);
  }

  updateAgentProbe(agentId: string, probe: ProbeResult, nowIso = new Date().toISOString()): void {
    const valid = ProbeResultSchema.parse(probe);
    const result = this.db.connection
      .prepare('UPDATE agent_configs SET probe_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(valid), nowIso, agentId);
    if (result.changes === 0) {
      throw new MindchestraError('NOT_FOUND', `Agent config ${agentId} not found`);
    }
  }

  getAgentConfig(agentId: string): { config: AgentConfig; probe: ProbeResult | null } | undefined {
    const row = this.db.connection
      .prepare('SELECT config_json, probe_json FROM agent_configs WHERE id = ?')
      .get(agentId) as { config_json: string; probe_json: string | null } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      config: AgentConfigSchema.parse(JSON.parse(row.config_json)),
      probe: row.probe_json ? ProbeResultSchema.parse(JSON.parse(row.probe_json)) : null
    };
  }

  listAgentConfigs(): Array<{ config: AgentConfig; probe: ProbeResult | null }> {
    const rows = this.db.connection
      .prepare('SELECT config_json, probe_json FROM agent_configs ORDER BY id ASC')
      .all() as Array<{ config_json: string; probe_json: string | null }>;
    return rows.map((row) => ({
      config: AgentConfigSchema.parse(JSON.parse(row.config_json)),
      probe: row.probe_json ? ProbeResultSchema.parse(JSON.parse(row.probe_json)) : null
    }));
  }

  deleteAgentConfig(agentId: string): void {
    const activeRuns = this.countActiveRunsForAgent(agentId);
    if (activeRuns > 0) {
      throw new MindchestraError('CONFLICT', `Agent ${agentId} has active runs and cannot be removed`);
    }
    const result = this.db.connection.prepare('DELETE FROM agent_configs WHERE id = ?').run(agentId);
    if (result.changes === 0) {
      throw new MindchestraError('NOT_FOUND', `Agent ${agentId} not found`);
    }
  }

  upsertMcpServer(
    config: MCPServerConfig,
    status = 'registered',
    tools: ToolDescriptor[] = [],
    nowIso = new Date().toISOString()
  ): void {
    const valid = MCPServerConfigSchema.parse(config);
    const validTools = tools.map((tool) => ToolDescriptorSchema.parse(tool));
    this.db.connection
      .prepare(
        `INSERT INTO mcp_servers (id, label, enabled, transport_kind, config_json, status, tools_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           enabled = excluded.enabled,
           transport_kind = excluded.transport_kind,
           config_json = excluded.config_json,
           status = excluded.status,
           tools_json = excluded.tools_json,
           updated_at = excluded.updated_at`
      )
      .run(
        valid.id,
        valid.label,
        valid.enabled ? 1 : 0,
        valid.transport.kind,
        JSON.stringify(valid),
        status,
        JSON.stringify(validTools),
        nowIso
      );
  }

  updateMcpServerDiscovery(
    serverId: string,
    status: string,
    tools: ToolDescriptor[],
    nowIso = new Date().toISOString()
  ): void {
    const validTools = tools.map((tool) => ToolDescriptorSchema.parse(tool));
    const result = this.db.connection
      .prepare('UPDATE mcp_servers SET status = ?, tools_json = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(validTools), nowIso, serverId);
    if (result.changes === 0) {
      throw new MindchestraError('NOT_FOUND', `MCP server ${serverId} not found`);
    }
  }

  getMcpServer(serverId: string): { config: MCPServerConfig; status: string; tools: ToolDescriptor[] } | undefined {
    const row = this.db.connection
      .prepare('SELECT config_json, status, tools_json FROM mcp_servers WHERE id = ?')
      .get(serverId) as { config_json: string; status: string; tools_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      config: MCPServerConfigSchema.parse(JSON.parse(row.config_json)),
      status: row.status,
      tools: (JSON.parse(row.tools_json) as unknown[]).map((tool) => ToolDescriptorSchema.parse(tool))
    };
  }

  listMcpServers(): MCPServerSummary[] {
    const rows = this.db.connection
      .prepare('SELECT id, label, enabled, transport_kind, status FROM mcp_servers ORDER BY id ASC')
      .all() as Array<{
      id: string;
      label: string;
      enabled: number;
      transport_kind: 'stdio' | 'streamable-http';
      status: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      enabled: row.enabled === 1,
      transport: row.transport_kind,
      status: row.status
    }));
  }

  upsertWorkspace(workspace: WorkspaceRecord): WorkspaceSummary {
    this.db.connection
      .prepare(
        `INSERT INTO workspaces (id, label, canonical_path, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           canonical_path = excluded.canonical_path`
      )
      .run(workspace.id, workspace.label, workspace.canonicalPath, workspace.createdAt);

    return {
      id: workspace.id,
      label: workspace.label
    };
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.db.connection
      .prepare('SELECT id, label, canonical_path, created_at FROM workspaces WHERE id = ?')
      .get(workspaceId) as
      | { id: string; label: string; canonical_path: string; created_at: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      label: row.label,
      canonicalPath: row.canonical_path,
      createdAt: row.created_at
    };
  }

  listWorkspaces(): WorkspaceSummary[] {
    const rows = this.db.connection
      .prepare('SELECT id, label FROM workspaces ORDER BY created_at DESC')
      .all() as Array<{ id: string; label: string }>;
    return rows.map((row) => ({ id: row.id, label: row.label }));
  }

  recoverInterruptedState(nowIso = new Date().toISOString()): RecoveryReport {
    return this.db.transaction(() => {
      const missionRows = this.db.connection
        .prepare("SELECT id, phase FROM missions WHERE status IN ('running', 'cancel_requested', 'waiting_approval')")
        .all() as Array<{ id: string; phase: Phase }>;

      const interruptedMissions: string[] = [];
      const interruptedRuns: string[] = [];
      const unknownOutcomeToolCalls: string[] = [];

      const activeRunRows = this.db.connection
        .prepare("SELECT id FROM runs WHERE status = 'running'")
        .all() as Array<{ id: string }>;

      if (activeRunRows.length > 0) {
        this.db.connection
          .prepare("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
          .run(nowIso);
        for (const row of activeRunRows) {
          interruptedRuns.push(row.id);
        }
      }

      const pendingCallRows = this.db.connection
        .prepare("SELECT id FROM tool_calls WHERE status = 'pending'")
        .all() as Array<{ id: string }>;

      if (pendingCallRows.length > 0) {
        this.db.connection
          .prepare("UPDATE tool_calls SET status = 'unknown_outcome', updated_at = ? WHERE status = 'pending'")
          .run(nowIso);
        for (const row of pendingCallRows) {
          unknownOutcomeToolCalls.push(row.id);
        }
      }

      for (const mission of missionRows) {
        interruptedMissions.push(mission.id);
        const claims = this.listClaimsByMission(mission.id);
        const evidence = this.listEvidenceByMission(mission.id);
        const verdicts = this.listVerdictsByMission(mission.id);
        const result: MissionResult = {
          missionId: mission.id,
          status: 'interrupted',
          summary: 'Mission interrupted due to daemon restart; no automatic re-execution performed.',
          claims: claims.map((c) => c.id),
          evidence: evidence.map((e) => e.id),
          verdicts: verdicts.map((v) => v.id),
          artifactIds: [],
          unresolved: ['Daemon restarted while mission was active']
        };

        this.eventStore.appendEvent({
          missionId: mission.id,
          actor: 'daemon',
          correlationId: randomUUID(),
          at: nowIso,
          payload: {
            type: 'mission.status',
            payload: { status: 'interrupted' }
          },
          missionUpdate: {
            status: 'interrupted',
            result
          }
        });
      }

      return {
        interruptedMissions,
        interruptedRuns,
        unknownOutcomeToolCalls
      };
    });
  }
}
