import { randomUUID } from 'node:crypto';
import {
  AgentEventSchema,
  MindchestraError,
  canonicalJson,
  sha256Hex,
  type AgentEvent,
  type AgentEventPayload,
  type MissionResult,
  type MissionStatus,
  type Phase
} from '@mindchestra/contracts';
import type { SqliteDatabase } from './database.js';

export type EventSubscriber = (event: AgentEvent) => void;

export interface AppendEventInput {
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
}

export interface ChainVerificationResult {
  valid: boolean;
  count: number;
  brokenAtSeq?: number;
}

export class EventStore {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();

  constructor(private readonly db: SqliteDatabase) {}

  subscribe(missionId: string, listener: EventSubscriber): () => void {
    let set = this.subscribers.get(missionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(missionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.subscribers.get(missionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.subscribers.delete(missionId);
      }
    };
  }

  appendEvent(input: AppendEventInput): AgentEvent {
    const persistedEvent = this.db.transaction(() => {
      const missionRow = this.db.connection
        .prepare('SELECT last_seq, status, phase, base_commit, pending_approval_ids_json FROM missions WHERE id = ?')
        .get(input.missionId) as
        | {
            last_seq: number;
            status: MissionStatus;
            phase: Phase;
            base_commit: string | null;
            pending_approval_ids_json: string;
          }
        | undefined;

      if (!missionRow) {
        throw new MindchestraError('NOT_FOUND', `Mission ${input.missionId} not found`);
      }

      const prevRow = this.db.connection
        .prepare('SELECT chain_hash FROM events WHERE mission_id = ? AND seq = ?')
        .get(input.missionId, missionRow.last_seq) as { chain_hash: string } | undefined;

      const seq = missionRow.last_seq + 1;
      const at = input.at ?? new Date().toISOString();
      const id = input.id ?? randomUUID();

      const candidate: Record<string, unknown> = {
        ...input.payload,
        schemaVersion: 1,
        seq,
        id,
        missionId: input.missionId,
        actor: input.actor,
        at,
        correlationId: input.correlationId
      };
      if (input.runId !== undefined) {
        candidate.runId = input.runId;
      }
      if (input.causationId !== undefined) {
        candidate.causationId = input.causationId;
      }

      const event = AgentEventSchema.parse(candidate);
      const prevChain = prevRow?.chain_hash ?? 'GENESIS';
      const chainHash = sha256Hex(`${prevChain}|${canonicalJson(event)}`);
      const envelopeJson = JSON.stringify(event);

      this.db.connection
        .prepare(
          `INSERT INTO events (
            mission_id, seq, id, actor, type, run_id, correlation_id, causation_id, at, envelope_json, chain_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.missionId,
          event.seq,
          event.id,
          event.actor,
          event.type,
          event.runId ?? null,
          event.correlationId,
          event.causationId ?? null,
          event.at,
          envelopeJson,
          chainHash
        );

      const nextStatus = input.missionUpdate?.status ?? missionRow.status;
      const nextPhase = input.missionUpdate?.phase ?? missionRow.phase;
      const nextBaseCommit = input.missionUpdate?.baseCommit ?? missionRow.base_commit;
      const nextPendingJson =
        input.missionUpdate?.pendingApprovalIds !== undefined
          ? JSON.stringify(input.missionUpdate.pendingApprovalIds)
          : missionRow.pending_approval_ids_json;

      if (input.missionUpdate?.result !== undefined) {
        this.db.connection
          .prepare(
            `UPDATE missions
             SET last_seq = ?, status = ?, phase = ?, base_commit = ?, pending_approval_ids_json = ?, result_json = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            seq,
            nextStatus,
            nextPhase,
            nextBaseCommit,
            nextPendingJson,
            JSON.stringify(input.missionUpdate.result),
            at,
            input.missionId
          );
      } else {
        this.db.connection
          .prepare(
            `UPDATE missions
             SET last_seq = ?, status = ?, phase = ?, base_commit = ?, pending_approval_ids_json = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(seq, nextStatus, nextPhase, nextBaseCommit, nextPendingJson, at, input.missionId);
      }

      return event;
    });

    const listeners = this.subscribers.get(input.missionId);
    if (listeners) {
      for (const listener of [...listeners]) {
        listener(persistedEvent);
      }
    }

    return persistedEvent;
  }

  listEventsAfter(missionId: string, afterSeq = 0, limit = 1000): AgentEvent[] {
    const missionRow = this.db.connection
      .prepare('SELECT retained_from_seq FROM missions WHERE id = ?')
      .get(missionId) as { retained_from_seq: number } | undefined;

    if (!missionRow) {
      throw new MindchestraError('NOT_FOUND', `Mission ${missionId} not found`);
    }

    if (afterSeq < missionRow.retained_from_seq - 1) {
      throw new MindchestraError('CURSOR_EXPIRED', 'Requested SSE cursor precedes retained event history', {
        details: {
          afterSeq,
          retainedFromSeq: missionRow.retained_from_seq
        }
      });
    }

    const boundedLimit = Math.max(1, Math.min(limit, 10000));
    const rows = this.db.connection
      .prepare('SELECT envelope_json FROM events WHERE mission_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(missionId, afterSeq, boundedLimit) as Array<{ envelope_json: string }>;

    return rows.map((row) => AgentEventSchema.parse(JSON.parse(row.envelope_json)));
  }

  pruneEventsBefore(missionId: string, keepFromSeq: number): number {
    return this.db.transaction(() => {
      const missionRow = this.db.connection
        .prepare('SELECT id FROM missions WHERE id = ?')
        .get(missionId) as { id: string } | undefined;
      if (!missionRow) {
        throw new MindchestraError('NOT_FOUND', `Mission ${missionId} not found`);
      }

      const result = this.db.connection
        .prepare('DELETE FROM events WHERE mission_id = ? AND seq < ?')
        .run(missionId, keepFromSeq);

      this.db.connection
        .prepare('UPDATE missions SET retained_from_seq = MAX(retained_from_seq, ?) WHERE id = ?')
        .run(keepFromSeq, missionId);

      return Number(result.changes);
    });
  }

  verifyEventChain(missionId: string): ChainVerificationResult {
    const rows = this.db.connection
      .prepare('SELECT seq, envelope_json, chain_hash FROM events WHERE mission_id = ? ORDER BY seq ASC')
      .all(missionId) as Array<{ seq: number; envelope_json: string; chain_hash: string }>;

    let prevChain = 'GENESIS';
    for (const row of rows) {
      const event = AgentEventSchema.parse(JSON.parse(row.envelope_json));
      const expected = sha256Hex(`${prevChain}|${canonicalJson(event)}`);
      if (expected !== row.chain_hash) {
        return {
          valid: false,
          count: rows.length,
          brokenAtSeq: row.seq
        };
      }
      prevChain = row.chain_hash;
    }

    return {
      valid: true,
      count: rows.length
    };
  }
}
