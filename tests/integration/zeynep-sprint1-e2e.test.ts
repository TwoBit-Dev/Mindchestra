import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  type AgentEvent,
  type MissionSnapshot
} from '@mindchestra/contracts';
import { createDaemonApp, InProcessAdapterRegistry, listenLoopback, type DaemonContext } from '@mindchestra/daemon';
import { DeterministicMockAdapter } from '@mindchestra/adapters';
import { DaemonClient } from '../../apps/cli/src/client.js';

describe('Zeynep Sprint 1: E2E Adapter, Registry, CLI Client & Daemon Integration', () => {
  let tempDir: string;
  let daemon: DaemonContext;
  let baseUrl: string;
  let userToken: string;
  let client: DaemonClient;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mindchestra-zeynep-e2e-'));
    const dbPath = path.join(tempDir, 'state.sqlite');
    const artifactDir = path.join(tempDir, 'artifacts');
    const workspaceDir = path.join(tempDir, 'demo-repo');
    mkdtempSync(workspaceDir);

    // Register our deterministic mock adapters into the registry
    const registry = new InProcessAdapterRegistry();
    const mockAgent1 = new DeterministicMockAdapter({
      id: 'mock-agent-1',
      displayName: 'Deterministic Mock Agent 1',
      chunks: ['Found memory leak in render loop', 'Allocations exceed frame budget']
    });
    const mockAgent2 = new DeterministicMockAdapter({
      id: 'mock-agent-2',
      displayName: 'Deterministic Mock Agent 2',
      chunks: ['Confirmed GC spike during asset reload']
    });

    registry.register(mockAgent1);
    registry.register(mockAgent2);

    daemon = await createDaemonApp({
      dbPath,
      artifactRoot: artifactDir,
      adapters: registry
    });

    const listen = await listenLoopback(daemon, { port: 0 });
    baseUrl = `http://127.0.0.1:${listen.port}`;
    userToken = daemon.auth.getDefaultUserToken()!;
    client = new DaemonClient(baseUrl, userToken);

    // Register test workspace in daemon
    const wsRes = await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        label: 'demo-repo',
        path: tempDir
      })
    });
    expect(wsRes.status).toBe(201);
  });

  afterEach(async () => {
    await daemon.app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('verifies daemon health and agent discovery via DaemonClient', async () => {
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.schemaVersion).toBe(1);

    const agents = await client.listAgents();
    expect(agents.items.length).toBeGreaterThanOrEqual(2);
    const agentIds = agents.items.map((a) => a.manifest.id);
    expect(agentIds).toContain('mock-agent-1');
    expect(agentIds).toContain('mock-agent-2');
  });

  it('probes registered mock adapters through daemon API', async () => {
    const probe = await client.probeAgent('mock-agent-1');
    expect(probe.status).toBe('ready');
    expect(probe.capabilities.streaming).toBe(true);
    expect(probe.capabilities.workspaceWrite).toBe(false); // default deny
  });

  it('runs an end-to-end mission with deterministic mock adapters and captures ordered events', async () => {
    const res = await fetch(`${baseUrl}/v1/missions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        'Idempotency-Key': 'zeynep-e2e-001'
      },
      body: JSON.stringify({
        schemaVersion: 1,
        objective: 'Analyze frame drop causes in game loop',
        mode: 'parallel',
        agents: ['mock-agent-1', 'mock-agent-2'],
        workspace: 'demo-repo',
        profile: 'read-only',
        budget: DEFAULT_BUDGET
      })
    });

    expect(res.status).toBe(202);
    const snapshot = (await res.json()) as MissionSnapshot;
    expect(snapshot.id).toBeDefined();
    expect(['queued', 'running']).toContain(snapshot.status);

    // Poll until mission reaches terminal state
    let finalSnapshot = snapshot;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      finalSnapshot = await client.getMission(snapshot.id);
      if (finalSnapshot.status !== 'running' && finalSnapshot.status !== 'queued') {
        break;
      }
    }

    expect(['completed', 'partial']).toContain(finalSnapshot.status);
    expect(finalSnapshot.lastSeq).toBeGreaterThan(0);

    // Fetch ordered SSE event stream
    const eventsRes = await fetch(`${baseUrl}/v1/missions/${snapshot.id}/events?after=0`, {
      headers: {
        authorization: `Bearer ${userToken}`
      }
    });
    expect(eventsRes.status).toBe(200);
    const text = await eventsRes.text();

    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as AgentEvent);

    expect(dataLines.length).toBeGreaterThan(0);

    // Check monotonic seq invariant
    for (let i = 1; i < dataLines.length; i++) {
      expect(dataLines[i]!.seq).toBeGreaterThan(dataLines[i - 1]!.seq);
    }
  });
});
