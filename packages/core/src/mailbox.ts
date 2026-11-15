import {
  AgentMessageSchema,
  MindchestraError,
  sha256Hex,
  type AgentMessage,
  type Phase
} from '@mindchestra/contracts';
import type { ClockPort, IdGeneratorPort, StoragePort } from './ports.js';

export const DEFAULT_MAX_MISSION_MESSAGES = 500;

export class PhaseMailbox {
  private readonly seenDedupKeys = new Map<string, Set<string>>();

  constructor(
    private readonly storage: StoragePort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly maxMessagesPerMission = DEFAULT_MAX_MISSION_MESSAGES
  ) {}

  isPhaseUnlocked(phase: Phase): boolean {
    return phase === 'critique' || phase === 'verify' || phase === 'synthesize' || phase === 'finalize';
  }

  sendMessage(input: {
    missionId: string;
    senderRunId: string;
    actor: string;
    correlationId: string;
    recipientAgentId: string;
    text: string;
    relatedClaimIds?: string[];
  }): { message: AgentMessage; deduplicated: boolean } {
    const snapshot = this.storage.getMissionSnapshot(input.missionId);
    if (!this.isPhaseUnlocked(snapshot.phase)) {
      throw new MindchestraError(
        'CONFLICT',
        `Phase barrier is active during ${snapshot.phase}; peer messages unlock in critique`
      );
    }

    const existing = this.storage.listMessagesByMission(input.missionId);
    if (existing.length >= this.maxMessagesPerMission) {
      throw new MindchestraError(
        'RATE_LIMITED',
        `Mission mailbox capacity (${this.maxMessagesPerMission}) reached`
      );
    }

    const dedupKey = sha256Hex(
      `${input.missionId}|${input.senderRunId}|${input.recipientAgentId}|${snapshot.phase}|${input.text}`
    );
    let keys = this.seenDedupKeys.get(input.missionId);
    if (!keys) {
      keys = new Set(
        existing.map((msg) =>
          sha256Hex(`${msg.missionId}|${msg.senderRunId}|${msg.recipientAgentId}|${msg.phase}|${msg.text}`)
        )
      );
      this.seenDedupKeys.set(input.missionId, keys);
    }

    if (keys.has(dedupKey)) {
      const matched = existing.find(
        (msg) =>
          sha256Hex(`${msg.missionId}|${msg.senderRunId}|${msg.recipientAgentId}|${msg.phase}|${msg.text}`) === dedupKey
      );
      if (matched) {
        return { message: matched, deduplicated: true };
      }
    }

    const message = AgentMessageSchema.parse({
      id: this.ids.nextId(),
      missionId: input.missionId,
      senderRunId: input.senderRunId,
      recipientAgentId: input.recipientAgentId,
      text: input.text,
      phase: snapshot.phase,
      relatedClaimIds: input.relatedClaimIds ?? [],
      at: this.clock.nowIso()
    });

    this.storage.insertMessage(message);
    keys.add(dedupKey);

    this.storage.appendEvent({
      missionId: input.missionId,
      actor: input.actor,
      correlationId: input.correlationId,
      runId: input.senderRunId,
      at: message.at,
      payload: {
        type: 'agent.message',
        payload: message
      }
    });

    return { message, deduplicated: false };
  }

  listVisibleMessages(missionId: string, targetAgentId?: string): AgentMessage[] {
    const snapshot = this.storage.getMissionSnapshot(missionId);
    if (!this.isPhaseUnlocked(snapshot.phase)) {
      return [];
    }
    const all = this.storage.listMessagesByMission(missionId);
    if (!targetAgentId) {
      return all;
    }
    return all.filter((msg) => msg.recipientAgentId === 'all' || msg.recipientAgentId === targetAgentId);
  }
}
