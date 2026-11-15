import type {
  AgentAdapter,
  AgentEvent,
  AgentEventPayload,
  AgentMessage,
  ApprovalRequest,
  ApprovalStatus,
  ArtifactMetadata,
  Claim,
  ClaimStatus,
  EvidenceRef,
  EvidenceStatus,
  MissionResult,
  MissionSnapshot,
  MissionSpec,
  MissionStatus,
  PaginatedResponse,
  Phase,
  ToolCall,
  ToolResult,
  UsageMetrics,
  Verdict
} from '@mindchestra/contracts';

export interface ClockPort {
  now(): Date;
  nowIso(): string;
}

export interface IdGeneratorPort {
  nextId(): string;
}

export interface AdapterRegistryPort {
  getAdapter(agentId: string): AgentAdapter | undefined;
  listAdapters(): AgentAdapter[];
}

export interface TrustedRunnerCheck {
  gateId: string;
  passed: boolean;
  sourceRef: string;
  artifactId?: string;
  sha256?: string;
  toolVersion?: string;
  detail?: string;
}

export interface TrustedRunnerPort {
  runVerification(input: {
    missionId: string;
    workspacePath: string;
    baseCommit?: string;
    candidateArtifactId?: string;
  }): Promise<TrustedRunnerCheck[]>;
}

export interface ResolvedWorkspaceInfo {
  id: string;
  label: string;
  canonicalPath: string;
  baseCommit?: string;
  dirty: boolean;
}

export interface WorkspacePort {
  resolveWorkspace(workspaceId: string): ResolvedWorkspaceInfo;
  validateSourceRef(workspacePath: string, sourceRef: string): boolean;
}

export interface ArtifactPort {
  putArtifact(input: {
    missionId: string;
    content: Buffer | string;
    contentType?: string;
    pinned?: boolean;
  }): ArtifactMetadata;
  getArtifactMetadata(artifactId: string): ArtifactMetadata;
  verifyArtifactIntegrity(artifactId: string): {
    valid: boolean;
    expectedSha256: string;
    actualSha256?: string;
  };
}

export interface CoreRunRecord {
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

export interface StoragePort {
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
  }): { snapshot: MissionSnapshot; deduplicated: boolean };
  getMissionSnapshot(missionId: string): MissionSnapshot;
  listMissions(options?: {
    cursor?: string;
    limit?: number;
    status?: MissionStatus;
  }): PaginatedResponse<MissionSnapshot>;
  getMissionResult(missionId: string): MissionResult;
  appendEvent(input: {
    missionId: string;
    actor: string;
    correlationId: string;
    runId?: string;
    causationId?: string;
    at?: string;
    id?: string;
    payload: AgentEventPayload;
    missionUpdate?: {
      status?: MissionStatus;
      phase?: Phase;
      result?: MissionResult;
      baseCommit?: string;
      pendingApprovalIds?: string[];
    };
  }): AgentEvent;
  listEventsAfter(missionId: string, afterSeq?: number, limit?: number): AgentEvent[];
  insertRun(run: CoreRunRecord): void;
  updateRun(
    runId: string,
    update: {
      status?: CoreRunRecord['status'];
      sessionId?: string;
      usage?: UsageMetrics;
      summary?: string;
      endedAt?: string;
    }
  ): void;
  listRunsByMission(missionId: string): CoreRunRecord[];
  insertClaim(claim: Claim, createdAt?: string): void;
  updateClaimStatus(claimId: string, status: ClaimStatus): void;
  listClaimsByMission(missionId: string): Claim[];
  insertEvidence(evidence: EvidenceRef): void;
  updateEvidenceStatus(evidenceId: string, status: EvidenceStatus): void;
  listEvidenceByMission(missionId: string): EvidenceRef[];
  insertVerdict(verdict: Verdict, createdAt?: string): void;
  listVerdictsByMission(missionId: string): Verdict[];
  insertMessage(message: AgentMessage): void;
  listMessagesByMission(missionId: string): AgentMessage[];
  listApprovals(options?: { missionId?: string; status?: ApprovalStatus }): ApprovalRequest[];
  insertToolCall(call: ToolCall, status: ToolResult['status'] | 'pending', nowIso?: string): void;
  completeToolCall(result: ToolResult, nowIso?: string): void;
}
