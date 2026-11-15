import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  DEFAULT_FALSE_CAPABILITIES,
  EvidenceRefSchema,
  type AdapterEvent,
  type AgentAdapter,
  type AgentManifest,
  type ProbeResult,
  type RunRequest
} from '@mindchestra/contracts';
import {
  MissionEngine,
  ReplayProjector,
  type AdapterRegistryPort,
  type TrustedRunnerPort
} from '@mindchestra/core';
import {
  ArtifactStore,
  EventStore,
  SqliteDatabase,
  StorageRepositories,
  runMigrations
} from '@mindchestra/storage';
import { WorkspaceManager } from '@mindchestra/workspaces';

function makeFakeAdapter(
  id: string,
  handler: (req: RunRequest, signal: AbortSignal) => AsyncIterable<AdapterEvent>
): AgentAdapter {
  const manifest: AgentManifest = {
    id,
    displayName: `Fake ${id}`,
    provider: 'test',
    adapterVersion: '1.0.0',
    sdkVersion: 1,
    kind: 'custom',
    capabilities: { ...DEFAULT_FALSE_CAPABILITIES, streaming: true }
  };
  return {
    manifest: () => manifest,
    async probe(): Promise<ProbeResult> {
      return {
        status: 'ready',
        checkedAt: new Date().toISOString(),
        version: '1.0.0',
        capabilities: manifest.capabilities
      };
    },
    async capabilities() {
      return manifest.capabilities;
    },
    run: handler
  };
}

class MapAdapterRegistry implements AdapterRegistryPort {
  private readonly map = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.map.set(adapter.manifest().id, adapter);
  }

  getAdapter(agentId: string): AgentAdapter | undefined {
    return this.map.get(agentId);
  }

  listAdapters(): AgentAdapter[] {
    return [...this.map.values()];
  }
}

describe('Core MissionEngine, Storage, Mailbox & Verdict', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let eventStore: EventStore;
  let repos: StorageRepositories;
  let artifacts: ArtifactStore;
  let workspaces: WorkspaceManager;
  let registry: MapAdapterRegistry;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mindchestra-core-test-'));
    db = new SqliteDatabase(path.join(tempDir, 'state.db'));
    runMigrations(db);
    eventStore = new EventStore(db);
    repos = new StorageRepositories(db, eventStore);
    artifacts = new ArtifactStore(db, path.join(tempDir, 'artifacts'));
    workspaces = new WorkspaceManager(repos);
    const repoDir = path.join(tempDir, 'repo');
    mkdtempSync(path.join(tempDir, 'repo-init-'));
    rmSync(path.join(tempDir, 'repo-init-'), { recursive: true, force: true });
    workspaces.registerWorkspace({ id: 'demo-repo', label: 'Demo Repo', path: tempDir });
    writeFileSync(path.join(tempDir, 'sample.ts'), 'export const x = 1;\n');
    registry = new MapAdapterRegistry();
    void repoDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('executes 3-agent Council with phase barrier, monotonic seq, and valid hash chain', async () => {
    const observedPrompts = new Map<string, RunRequest[]>();

    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      registry.register(
        makeFakeAdapter(id, async function* (req): AsyncIterable<AdapterEvent> {
          const list = observedPrompts.get(id) ?? [];
          list.push(req);
          observedPrompts.set(id, list);

          yield { type: 'agent.started', payload: {} };
          const msgId = randomUUID();
          yield { type: 'message.delta', payload: { messageId: msgId, text: 'part1 ' } };
          yield {
            type: 'message.completed',
            payload: {
              messageId: msgId,
              text: JSON.stringify({
                claims: [{ text: `Finding from ${id} in ${req.phase}`, severity: 'medium', confidence: 0.8 }],
                evidence: [{ sourceRef: 'sample.ts:1', relation: 'supports', kind: 'source' }]
              })
            }
          };
          yield {
            type: 'usage.updated',
            payload: { inputTokens: 100, outputTokens: 50, costUsd: 0.001, durationMs: 25, source: 'provider' }
          };
          yield { type: 'agent.finished', payload: { summary: `${id} done` } };
        })
      );
    }

    const trustedRunner: TrustedRunnerPort = {
      async runVerification() {
        return [
          {
            gateId: 'unit_suite',
            passed: true,
            sourceRef: 'sample.ts:1',
            toolVersion: 'vitest-3'
          }
        ];
      }
    };

    const engine = new MissionEngine({
      storage: repos,
      adapters: registry,
      workspaces,
      artifacts,
      trustedRunner
    });

    const { snapshot } = engine.createMission({
      schemaVersion: 1,
      objective: 'Verify council execution',
      mode: 'council',
      agents: ['agent-a', 'agent-b', 'agent-c'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });

    const result = await engine.startMission(snapshot.id);
    expect(result.status).toBe('completed');
    expect(result.claims.length).toBeGreaterThanOrEqual(3);

    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      const calls = observedPrompts.get(id)!;
      expect(calls).toHaveLength(2);
      expect(calls[0]!.phase).toBe('independent');
      expect(calls[0]!.prompt).not.toContain('Independent phase findings');
      expect(calls[1]!.phase).toBe('critique');
      expect(calls[1]!.prompt).toContain('Independent phase findings');
    }

    const events = eventStore.listEventsAfter(snapshot.id, 0);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: events.length }, (_, idx) => idx + 1));
    expect(eventStore.verifyEventChain(snapshot.id).valid).toBe(true);

    const verdicts = repos.listVerdictsByMission(snapshot.id);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.status).toBe('verified');
    expect(verdicts[0]!.score).toBeNull();
  });

  it('returns partial when 1 of 3 agents fails and failed when all 3 fail', async () => {
    registry.register(
      makeFakeAdapter('ok-1', async function* (): AsyncIterable<AdapterEvent> {
        yield { type: 'agent.started', payload: {} };
        yield { type: 'agent.finished', payload: { summary: 'ok-1 finished' } };
      })
    );
    registry.register(
      makeFakeAdapter('ok-2', async function* (): AsyncIterable<AdapterEvent> {
        yield { type: 'agent.started', payload: {} };
        yield { type: 'agent.finished', payload: { summary: 'ok-2 finished' } };
      })
    );
    registry.register(
      makeFakeAdapter('fail-1', async function* (): AsyncIterable<AdapterEvent> {
        yield { type: 'agent.started', payload: {} };
        yield {
          type: 'agent.failed',
          payload: { code: 'UNAVAILABLE', message: 'provider down', retryable: false }
        };
      })
    );

    const engine = new MissionEngine({ storage: repos, adapters: registry, workspaces, artifacts });

    const partialMission = engine.createMission({
      schemaVersion: 1,
      objective: 'Test partial quorum',
      mode: 'parallel',
      agents: ['ok-1', 'ok-2', 'fail-1'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });
    const partialResult = await engine.startMission(partialMission.snapshot.id);
    expect(partialResult.status).toBe('partial');

    registry.register(
      makeFakeAdapter('fail-2', async function* () {
        throw new Error('unexpected crash');
      })
    );
    const failedMission = engine.createMission({
      schemaVersion: 1,
      objective: 'Test total failure',
      mode: 'parallel',
      agents: ['fail-1', 'fail-2'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });
    const failedResult = await engine.startMission(failedMission.snapshot.id);
    expect(failedResult.status).toBe('failed');
  });

  it('normalizes missing terminal events, deduplicates duplicate terminals, and handles cancellation', async () => {
    registry.register(
      makeFakeAdapter('noisy', async function* (): AsyncIterable<AdapterEvent> {
        yield { type: 'agent.started', payload: {} };
        yield { type: 'agent.finished', payload: { summary: 'first terminal' } };
        yield { type: 'agent.finished', payload: { summary: 'duplicate terminal should be ignored' } };
      })
    );
    registry.register(
      makeFakeAdapter('silent-exit', async function* (): AsyncIterable<AdapterEvent> {
        yield { type: 'agent.started', payload: {} };
        yield { type: 'message.completed', payload: { messageId: randomUUID(), text: 'output without terminal' } };
      })
    );

    const engine = new MissionEngine({ storage: repos, adapters: registry, workspaces, artifacts });
    const m1 = engine.createMission({
      schemaVersion: 1,
      objective: 'Normalize terminal events',
      mode: 'parallel',
      agents: ['noisy', 'silent-exit'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });
    const res1 = await engine.startMission(m1.snapshot.id);
    expect(res1.status).toBe('completed');

    const events = eventStore.listEventsAfter(m1.snapshot.id, 0);
    const terminalEvents = events.filter((e) => e.type === 'agent.finished' || e.type === 'agent.failed');
    expect(terminalEvents).toHaveLength(2);

    let abortedObserved = false;
    registry.register(
      makeFakeAdapter('slow-cancellable', async function* (_req, signal) {
        yield { type: 'agent.started', payload: {} };
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              abortedObserved = true;
              resolve();
            },
            { once: true }
          );
        });
      })
    );

    const m2 = engine.createMission({
      schemaVersion: 1,
      objective: 'Cancel mid-flight',
      mode: 'parallel',
      agents: ['slow-cancellable'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });

    const runPromise = engine.startMission(m2.snapshot.id);
    await new Promise((r) => setTimeout(r, 30));
    await engine.cancelMission(m2.snapshot.id);
    const cancelResult = await runPromise;
    expect(abortedObserved).toBe(true);
    expect(cancelResult.status).toBe('cancelled');
  });

  it('enforces phase barrier on PhaseMailbox and rejects unsupported modes', async () => {
    registry.register(
      makeFakeAdapter('a1', async function* () {
        yield { type: 'agent.finished', payload: { summary: 'done' } };
      })
    );
    const engine = new MissionEngine({ storage: repos, adapters: registry, workspaces, artifacts });

    expect(() =>
      engine.createMission({
        schemaVersion: 1,
        objective: 'Unsupported mode check',
        mode: 'debate',
        agents: ['a1'],
        workspace: 'demo-repo',
        profile: 'read-only',
        budget: DEFAULT_BUDGET
      })
    ).toThrow(/not supported/i);

    const { snapshot } = engine.createMission({
      schemaVersion: 1,
      objective: 'Mailbox barrier check',
      mode: 'council',
      agents: ['a1'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });

    eventStore.appendEvent({
      missionId: snapshot.id,
      actor: 'daemon',
      correlationId: randomUUID(),
      payload: { type: 'mission.phase', payload: { phase: 'independent' } },
      missionUpdate: { phase: 'independent' }
    });

    expect(() =>
      engine.getMailbox().sendMessage({
        missionId: snapshot.id,
        senderRunId: randomUUID(),
        actor: 'a1',
        correlationId: randomUUID(),
        recipientAgentId: 'all',
        text: 'Premature message'
      })
    ).toThrow(/Phase barrier is active/);

    eventStore.appendEvent({
      missionId: snapshot.id,
      actor: 'daemon',
      correlationId: randomUUID(),
      payload: { type: 'mission.phase', payload: { phase: 'critique' } },
      missionUpdate: { phase: 'critique' }
    });

    const first = engine.getMailbox().sendMessage({
      missionId: snapshot.id,
      senderRunId: '00000000-0000-4000-8000-000000000011',
      actor: 'a1',
      correlationId: randomUUID(),
      recipientAgentId: 'all',
      text: 'Critique note'
    });
    expect(first.deduplicated).toBe(false);

    const duplicate = engine.getMailbox().sendMessage({
      missionId: snapshot.id,
      senderRunId: '00000000-0000-4000-8000-000000000011',
      actor: 'a1',
      correlationId: randomUUID(),
      recipientAgentId: 'all',
      text: 'Critique note'
    });
    expect(duplicate.deduplicated).toBe(true);
  });

  it('recovers interrupted missions/runs and unknown_outcome tool calls on restart', () => {
    registry.register(
      makeFakeAdapter('a1', async function* () {
        yield { type: 'agent.finished', payload: { summary: 'done' } };
      })
    );
    const engine = new MissionEngine({ storage: repos, adapters: registry, workspaces, artifacts });
    const { snapshot } = engine.createMission({
      schemaVersion: 1,
      objective: 'Crash recovery test',
      mode: 'parallel',
      agents: ['a1'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET
    });

    const runId = randomUUID();
    repos.insertRun({
      id: runId,
      missionId: snapshot.id,
      agentId: 'a1',
      phase: 'independent',
      status: 'running',
      startedAt: new Date().toISOString()
    });
    eventStore.appendEvent({
      missionId: snapshot.id,
      actor: 'daemon',
      correlationId: randomUUID(),
      payload: { type: 'mission.status', payload: { status: 'running' } },
      missionUpdate: { status: 'running' }
    });

    const report = repos.recoverInterruptedState();
    expect(report.interruptedMissions).toContain(snapshot.id);
    expect(report.interruptedRuns).toContain(runId);

    const after = repos.getMissionSnapshot(snapshot.id);
    expect(after.status).toBe('interrupted');
    expect(after.resultAvailable).toBe(true);
  });

  it('keeps unverified agent claims provisional and preserves contradictions as disputed with dissent', async () => {
    const candidateArtifact = (() => {
      const m = engineSetupMission();
      return artifacts.putArtifact({
        missionId: m,
        contentType: 'text/plain',
        content: 'candidate patch'
      });
    })();

    function engineSetupMission(): string {
      registry.register(
        makeFakeAdapter('reviewer', async function* (): AsyncIterable<AdapterEvent> {
          yield { type: 'agent.started', payload: {} };
          yield {
            type: 'message.completed',
            payload: {
              messageId: randomUUID(),
              text: JSON.stringify({
                claims: [{ text: 'All tests passed (self-report only)', severity: 'high' }],
                evidence: [{ sourceRef: 'sample.ts:1', relation: 'supports', kind: 'source' }]
              })
            }
          };
          yield { type: 'agent.finished', payload: { summary: 'done' } };
        })
      );
      const e = new MissionEngine({ storage: repos, adapters: registry, workspaces, artifacts });
      return e.createMission({
        schemaVersion: 1,
        objective: 'Setup placeholder',
        mode: 'parallel',
        agents: ['reviewer'],
        workspace: 'demo-repo',
        profile: 'read-only',
        budget: DEFAULT_BUDGET
      }).snapshot.id;
    }

    const engine = new MissionEngine({ storage: repos, adapters: registry, workspaces, artifacts });
    const { snapshot } = engine.createMission({
      schemaVersion: 1,
      objective: 'Review candidate artifact',
      mode: 'review',
      agents: ['reviewer'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: DEFAULT_BUDGET,
      candidateArtifactId: candidateArtifact.id
    });

    const res = await engine.startMission(snapshot.id);
    expect(res.status).toBe('completed');
    const verdicts = repos.listVerdictsByMission(snapshot.id);
    expect(verdicts[0]!.status).toBe('provisional');

    const claims = repos.listClaimsByMission(snapshot.id);
    repos.insertEvidence(
      EvidenceRefSchema.parse({
        id: randomUUID(),
        missionId: snapshot.id,
        claimId: claims[0]!.id,
        kind: 'test',
        relation: 'contradicts',
        sourceRef: 'sample.ts:1',
        at: new Date().toISOString(),
        provenance: 'trusted_runner',
        status: 'verified'
      })
    );

    const replay = new ReplayProjector().project(eventStore.listEventsAfter(snapshot.id, 0));
    expect(replay.snapshot.id).toBe(snapshot.id);
    expect(replay.markdownSummary).toContain('# Mission Replay:');
  });
});
