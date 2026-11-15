import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  DEFAULT_FALSE_CAPABILITIES,
  type AdapterEvent,
  type AgentAdapter,
  type AgentEvent,
  type MissionResult,
  type MissionSnapshot
} from '@mindchestra/contracts';
import { createDaemonApp, InProcessAdapterRegistry, listenLoopback, type DaemonContext } from '@mindchestra/daemon';
import { HttpDaemonMcpBackend, createUpstreamMcpServer } from '@mindchestra/mcp-server';

const fakeMcpScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-mcp-server.mjs');

function makeDelayedFakeAdapter(id: string, delayMs: number): AgentAdapter {
  const manifest = {
    id,
    displayName: `Adapter ${id}`,
    provider: 'test',
    adapterVersion: '1.0.0',
    sdkVersion: 1 as const,
    kind: 'custom' as const,
    capabilities: { ...DEFAULT_FALSE_CAPABILITIES, streaming: true }
  };
  return {
    manifest: () => manifest,
    probe: async () => ({
      status: 'ready',
      checkedAt: new Date().toISOString(),
      version: '1.0.0',
      capabilities: manifest.capabilities
    }),
    capabilities: async () => manifest.capabilities,
    async *run(req): AsyncIterable<AdapterEvent> {
      yield { type: 'agent.started', payload: {} };
      await new Promise((r) => setTimeout(r, delayMs));
      const msgId = randomUUID();
      yield {
        type: 'message.completed',
        payload: {
          messageId: msgId,
          text: JSON.stringify({
            claims: [{ text: `${id} verified observation in ${req.phase}`, severity: 'medium' }]
          })
        }
      };
      yield { type: 'agent.finished', payload: { summary: `${id} complete` } };
    }
  };
}

function parseSseFrames(raw: string): Array<{ id?: number; event?: string; data?: AgentEvent }> {
  const blocks = raw.split('\n\n').map((b) => b.trim()).filter(Boolean);
  const frames: Array<{ id?: number; event?: string; data?: AgentEvent }> = [];
  for (const block of blocks) {
    if (block.startsWith(':')) {
      continue;
    }
    const frame: { id?: number; event?: string; data?: AgentEvent } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        frame.id = Number(line.slice(3).trim());
      } else if (line.startsWith('event:')) {
        frame.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        frame.data = JSON.parse(line.slice(5).trim()) as AgentEvent;
      }
    }
    frames.push(frame);
  }
  return frames;
}

describe('End-to-end Daemon HTTP/SSE + Upstream/Downstream MCP integration', () => {
  let tempDir: string;
  let daemon: DaemonContext;
  let baseUrl: string;
  let userToken: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mindchestra-e2e-'));
    const repoDir = path.join(tempDir, 'workspace');
    mkdtempSync(path.join(tempDir, 'tmp-check-'));
    rmSync(path.join(tempDir, 'tmp-check-'), { recursive: true, force: true });
    writeFileSync(path.join(tempDir, 'target.txt'), 'frameTimeMs=18.2\n');

    const registry = new InProcessAdapterRegistry();
    registry.register(makeDelayedFakeAdapter('codex-fake', 25));
    registry.register(makeDelayedFakeAdapter('claude-fake', 35));
    registry.register(makeDelayedFakeAdapter('agy-fake', 30));

    daemon = createDaemonApp({
      dbPath: path.join(tempDir, 'daemon.sqlite'),
      artifactRoot: path.join(tempDir, 'artifacts'),
      adapters: registry,
      sseHeartbeatMs: 200
    });
    userToken = daemon.auth.getDefaultUserToken()!;

    const { port } = await listenLoopback(daemon, { host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${port}`;
    void repoDir;
  });

  afterEach(async () => {
    await daemon.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('streams ordered SSE events, supports Last-Event-ID reconnect, cursor expiry, and idempotency', async () => {
    const wsRes = await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ label: 'demo-repo', path: tempDir })
    });
    expect(wsRes.status).toBe(201);

    const spec = {
      schemaVersion: 1 as const,
      objective: 'Analyze frame drops',
      mode: 'council' as const,
      agents: ['codex-fake', 'claude-fake', 'agy-fake'],
      workspace: 'demo-repo',
      profile: 'read-only' as const,
      budget: DEFAULT_BUDGET
    };

    const createRes = await fetch(`${baseUrl}/v1/missions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-key-001'
      },
      body: JSON.stringify(spec)
    });
    expect(createRes.status).toBe(202);
    const created = (await createRes.json()) as MissionSnapshot;

    const dupRes = await fetch(`${baseUrl}/v1/missions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-key-001'
      },
      body: JSON.stringify(spec)
    });
    expect(dupRes.status).toBe(202);
    const dupSnapshot = (await dupRes.json()) as MissionSnapshot;
    expect(dupSnapshot.id).toBe(created.id);

    const conflictRes = await fetch(`${baseUrl}/v1/missions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-key-001'
      },
      body: JSON.stringify({ ...spec, objective: 'Different objective' })
    });
    expect(conflictRes.status).toBe(409);

    const streamRes = await fetch(`${baseUrl}/v1/missions/${created.id}/events?after=0`, {
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(streamRes.status).toBe(200);
    const fullStreamText = await streamRes.text();
    const frames = parseSseFrames(fullStreamText);
    const seqs = frames.map((f) => f.id!);
    expect(seqs.length).toBeGreaterThan(5);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, idx) => idx + 1));
    expect(frames[frames.length - 1]!.data!.type).toBe('mission.result');

    const resumeAt = 3;
    const reconnectRes = await fetch(`${baseUrl}/v1/missions/${created.id}/events`, {
      headers: {
        authorization: `Bearer ${userToken}`,
        'last-event-id': String(resumeAt)
      }
    });
    expect(reconnectRes.status).toBe(200);
    const reconnectedFrames = parseSseFrames(await reconnectRes.text());
    expect(reconnectedFrames.map((f) => f.id)).toEqual(seqs.slice(resumeAt));

    const resultRes = await fetch(`${baseUrl}/v1/missions/${created.id}/result`, {
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(resultRes.status).toBe(200);
    const result = (await resultRes.json()) as MissionResult;
    expect(result.status).toBe('completed');

    const replayRes = await fetch(`${baseUrl}/v1/missions/${created.id}/replay?upToSeq=4`, {
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(replayRes.status).toBe(200);
    const replayJson = (await replayRes.json()) as { upToSeq: number; eventCount: number };
    expect(replayJson.upToSeq).toBe(4);
    expect(replayJson.eventCount).toBe(4);

    daemon.eventStore.pruneEventsBefore(created.id, 5);
    const expiredCursorRes = await fetch(`${baseUrl}/v1/missions/${created.id}/events?after=2`, {
      headers: { authorization: `Bearer ${userToken}` }
    });
    expect(expiredCursorRes.status).toBe(410);
  });

  it('connects upstream MCP facade to loopback daemon and real stdio downstream fake MCP server', async () => {
    await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ label: 'mcp-repo', path: tempDir })
    });

    const regMcpRes = await fetch(`${baseUrl}/v1/mcp/servers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: 'fake-profiler',
        label: 'Fake Profiler MCP',
        enabled: true,
        transport: {
          kind: 'stdio',
          command: process.execPath,
          args: [fakeMcpScript]
        }
      })
    });
    expect(regMcpRes.status).toBe(201);

    const probeMcpRes = await fetch(`${baseUrl}/v1/mcp/servers/fake-profiler/probe`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    expect(probeMcpRes.status).toBe(200);
    const probed = (await probeMcpRes.json()) as { tools: Array<{ name: string; schemaHash: string }> };
    expect(probed.tools.map((t) => t.name)).toContain('inspect_metrics');

    const inspectTool = probed.tools.find((t) => t.name === 'inspect_metrics')!;
    daemon.gateway.classifyTool('fake-profiler', 'inspect_metrics', 'read');

    const backend = new HttpDaemonMcpBackend(baseUrl, userToken);
    const { dispatcher } = createUpstreamMcpServer({
      backend,
      caller: { role: 'user', actorId: 'mcp-user', depth: 0 }
    });

    const startCall = await dispatcher.callTool('mission.start', {
      schemaVersion: 1,
      objective: 'Inspect profiler via downstream MCP',
      mode: 'parallel',
      agents: ['codex-fake'],
      workspace: 'mcp-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });
    expect(startCall.isError).toBeUndefined();
    const startPayload = JSON.parse((startCall.content[0] as { text: string }).text) as {
      missionId: string;
      status: string;
    };

    await daemon.engine.waitForMission(startPayload.missionId);
    const claims = daemon.repos.listClaimsByMission(startPayload.missionId);
    expect(claims.length).toBeGreaterThanOrEqual(1);

    daemon.repos.insertToolGrant({
      id: randomUUID(),
      missionId: startPayload.missionId,
      agentId: 'codex-fake',
      serverId: 'fake-profiler',
      toolName: 'inspect_metrics',
      schemaHash: inspectTool.schemaHash,
      access: 'read',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxCalls: 3
    });

    const invokeCall = await dispatcher.callTool('tools.invoke', {
      missionId: startPayload.missionId,
      serverId: 'fake-profiler',
      toolName: 'inspect_metrics',
      arguments: { target: 'game-loop' },
      claimId: claims[0]!.id
    });
    expect(invokeCall.isError).toBeUndefined();
    const toolResult = JSON.parse((invokeCall.content[0] as { text: string }).text) as {
      status: string;
      artifactIds: string[];
      summary: string;
    };
    expect(toolResult.status).toBe('ok');
    expect(toolResult.artifactIds).toHaveLength(1);
    expect(toolResult.summary).toContain('[REDACTED]');
    expect(toolResult.summary).not.toContain('sk-test-secret');

    const evidenceList = daemon.repos.listEvidenceByMission(startPayload.missionId);
    expect(evidenceList.some((e) => e.provenance === 'gateway' && e.status === 'verified')).toBe(true);

    const agentDispatcher = createUpstreamMcpServer({
      backend,
      caller: { role: 'agent', actorId: 'codex-fake', missionId: startPayload.missionId, depth: 1 }
    }).dispatcher;
    const recursiveRes = await agentDispatcher.callTool('mission.start', {
      schemaVersion: 1,
      objective: 'Attempt recursive mission start',
      mode: 'parallel',
      agents: ['codex-fake'],
      workspace: 'mcp-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });
    expect(recursiveRes.isError).toBe(true);
  });
});
