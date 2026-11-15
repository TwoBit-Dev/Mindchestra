import type {
  AgentSummary,
  Id,
  MissionSnapshot,
  MissionSpec,
  ProbeResult
} from '@mindchestra/contracts';

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(
    baseUrl = process.env.MINDCHESTRA_DAEMON_URL ?? 'http://127.0.0.1:4311',
    token = process.env.MINDCHESTRA_TOKEN
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) {
      h.authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  async health(): Promise<{ status: string; version: string; schemaVersion: number }> {
    const res = await fetch(`${this.baseUrl}/v1/health`);
    if (!res.ok) {
      throw new Error(`Health check returned HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
  }

  async listAgents(): Promise<{ items: AgentSummary[] }> {
    const res = await fetch(`${this.baseUrl}/v1/agents`, {
      headers: this.headers()
    });
    if (!res.ok) {
      throw new Error(`Failed to list agents (HTTP ${res.status}): ${res.statusText}`);
    }
    return res.json();
  }

  async probeAgent(id: string): Promise<ProbeResult> {
    const res = await fetch(`${this.baseUrl}/v1/agents/${encodeURIComponent(id)}/probe`, {
      method: 'POST',
      headers: this.headers()
    });
    if (!res.ok) {
      throw new Error(`Failed to probe agent ${id} (HTTP ${res.status}): ${res.statusText}`);
    }
    return res.json();
  }

  async createMission(spec: MissionSpec, idempotencyKey?: string): Promise<MissionSnapshot> {
    const h = this.headers({ 'Content-Type': 'application/json' });
    if (idempotencyKey) {
      h['Idempotency-Key'] = idempotencyKey;
    }
    const res = await fetch(`${this.baseUrl}/v1/missions`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(spec)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to create mission (HTTP ${res.status})`);
    }
    return res.json();
  }

  async getMission(id: Id): Promise<MissionSnapshot> {
    const res = await fetch(`${this.baseUrl}/v1/missions/${encodeURIComponent(id)}`, {
      headers: this.headers()
    });
    if (!res.ok) {
      throw new Error(`Failed to get mission ${id} (HTTP ${res.status}): ${res.statusText}`);
    }
    return res.json();
  }

  async cancelMission(id: Id): Promise<MissionSnapshot> {
    const res = await fetch(`${this.baseUrl}/v1/missions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: this.headers()
    });
    if (!res.ok) {
      throw new Error(`Failed to cancel mission ${id} (HTTP ${res.status}): ${res.statusText}`);
    }
    return res.json();
  }
}
