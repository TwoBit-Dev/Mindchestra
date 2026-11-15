import type {
  AgentEvent,
  AgentSummary,
  Id,
  MissionSnapshot,
  MissionSpec
} from '@mindchestra/contracts';

export interface SseSubscriptionOptions {
  missionId: Id;
  afterSeq?: number;
  onEvent: (event: AgentEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export class MindchestraApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  async getHealth(): Promise<{ status: string; version: string; schemaVersion: number }> {
    const res = await fetch(`${this.baseUrl}/v1/health`);
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.statusText}`);
    }
    return res.json();
  }

  async listMissions(limit = 50, cursor?: string): Promise<{ items: MissionSnapshot[]; nextCursor?: string }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${this.baseUrl}/v1/missions?${params}`);
    if (!res.ok) {
      throw new Error(`Failed to list missions: ${res.statusText}`);
    }
    return res.json();
  }

  async getMission(id: Id): Promise<MissionSnapshot> {
    const res = await fetch(`${this.baseUrl}/v1/missions/${encodeURIComponent(id)}`);
    if (!res.ok) {
      throw new Error(`Failed to get mission ${id}: ${res.statusText}`);
    }
    return res.json();
  }

  async createMission(spec: MissionSpec, idempotencyKey?: string): Promise<MissionSnapshot> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const res = await fetch(`${this.baseUrl}/v1/missions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(spec)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to create mission: ${res.statusText}`);
    }
    return res.json();
  }

  async cancelMission(id: Id): Promise<MissionSnapshot> {
    const res = await fetch(`${this.baseUrl}/v1/missions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST'
    });
    if (!res.ok) {
      throw new Error(`Failed to cancel mission ${id}: ${res.statusText}`);
    }
    return res.json();
  }

  async listAgents(): Promise<{ items: AgentSummary[] }> {
    const res = await fetch(`${this.baseUrl}/v1/agents`);
    if (!res.ok) {
      throw new Error(`Failed to list agents: ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * Subscribes to live SSE events with deduplication and auto-reconnect semantics.
   */
  subscribeToMissionEvents(options: SseSubscriptionOptions): () => void {
    let active = true;
    let lastSeq = options.afterSeq ?? 0;
    const seenSeqs = new Set<number>();
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!active) return;

      const url = `${this.baseUrl}/v1/missions/${encodeURIComponent(options.missionId)}/events?after=${lastSeq}`;
      eventSource = new EventSource(url);

      eventSource.addEventListener('mission.event', (e) => {
        try {
          const parsed = JSON.parse(e.data) as AgentEvent;
          if (seenSeqs.has(parsed.seq)) {
            return; // Dedup
          }
          seenSeqs.add(parsed.seq);
          lastSeq = Math.max(lastSeq, parsed.seq);
          options.onEvent(parsed);

          // Close if mission completed or terminal
          if (
            parsed.type === 'mission.status' &&
            ['completed', 'failed', 'cancelled', 'partial', 'interrupted'].includes(parsed.payload.status)
          ) {
            options.onClose?.();
            cleanup();
          }
        } catch (err) {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      });

      eventSource.onerror = (e) => {
        if (!active) return;
        eventSource?.close();
        options.onError?.(new Error('SSE connection error; reconnecting...'));
        reconnectTimeout = setTimeout(connect, 2000);
      };
    };

    const cleanup = () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };

    connect();
    return cleanup;
  }
}

export const api = new MindchestraApiClient();
