import {
  AgentEventSchema,
  type AgentEvent,
  type Claim,
  type EvidenceRef,
  type MissionSnapshot,
  type Verdict
} from '@mindchestra/contracts';

export interface ReplayState {
  missionId: string;
  upToSeq: number;
  eventCount: number;
  snapshot: MissionSnapshot;
  claims: Claim[];
  evidence: EvidenceRef[];
  verdicts: Verdict[];
  timeline: Array<{ seq: number; at: string; actor: string; type: string }>;
  markdownSummary: string;
}

export class ReplayProjector {
  project(events: AgentEvent[], upToSeq?: number): ReplayState {
    const ordered = [...events]
      .map((ev) => AgentEventSchema.parse(ev))
      .sort((a, b) => a.seq - b.seq)
      .filter((ev) => (upToSeq === undefined ? true : ev.seq <= upToSeq));

    if (ordered.length === 0) {
      throw new Error('Cannot project replay from empty event list');
    }

    const first = ordered[0]!;
    if (first.type !== 'mission.created') {
      throw new Error('First mission event must be mission.created');
    }

    let snapshot: MissionSnapshot = {
      id: first.missionId,
      spec: first.payload.spec,
      status: 'queued',
      phase: 'prepare',
      createdAt: first.at,
      updatedAt: first.at,
      lastSeq: first.seq,
      resultAvailable: false,
      pendingApprovalIds: []
    };

    const claims = new Map<string, Claim>();
    const evidence = new Map<string, EvidenceRef>();
    const verdicts = new Map<string, Verdict>();
    const timeline: Array<{ seq: number; at: string; actor: string; type: string }> = [];

    for (const event of ordered) {
      timeline.push({
        seq: event.seq,
        at: event.at,
        actor: event.actor,
        type: event.type
      });
      snapshot = {
        ...snapshot,
        updatedAt: event.at,
        lastSeq: event.seq
      };

      switch (event.type) {
        case 'mission.phase':
          snapshot = { ...snapshot, phase: event.payload.phase };
          break;
        case 'mission.status':
          snapshot = { ...snapshot, status: event.payload.status };
          break;
        case 'mission.result':
          snapshot = {
            ...snapshot,
            status: event.payload.status,
            resultAvailable: true
          };
          break;
        case 'claim.created':
          claims.set(event.payload.id, event.payload);
          break;
        case 'evidence.added':
          evidence.set(event.payload.id, event.payload);
          break;
        case 'verdict.created':
          verdicts.set(event.payload.id, event.payload);
          break;
        case 'approval.requested':
          if (!snapshot.pendingApprovalIds.includes(event.payload.id)) {
            snapshot = {
              ...snapshot,
              pendingApprovalIds: [...snapshot.pendingApprovalIds, event.payload.id]
            };
          }
          break;
        case 'approval.decided':
          snapshot = {
            ...snapshot,
            pendingApprovalIds: snapshot.pendingApprovalIds.filter((id) => id !== event.payload.approvalId)
          };
          break;
        default:
          break;
      }
    }

    const claimList = [...claims.values()];
    const evidenceList = [...evidence.values()];
    const verdictList = [...verdicts.values()];
    const lines = [
      `# Mission Replay: ${snapshot.id}`,
      `- Mode: ${snapshot.spec.mode}`,
      `- Status: ${snapshot.status}`,
      `- Phase: ${snapshot.phase}`,
      `- Last Seq: ${snapshot.lastSeq}`,
      `- Claims: ${claimList.length}`,
      `- Evidence: ${evidenceList.length}`,
      `- Verdicts: ${verdictList.length}`,
      '',
      '## Timeline',
      ...timeline.map((item) => `- [${item.seq}] ${item.at} (${item.actor}) ${item.type}`)
    ];

    return {
      missionId: snapshot.id,
      upToSeq: snapshot.lastSeq,
      eventCount: ordered.length,
      snapshot,
      claims: claimList,
      evidence: evidenceList,
      verdicts: verdictList,
      timeline,
      markdownSummary: lines.join('\n')
    };
  }
}
