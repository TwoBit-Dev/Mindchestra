import { randomUUID } from 'node:crypto';
import {
  AdapterEventSchema,
  ClaimSchema,
  EvidenceRefSchema,
  MAX_MVP_AGENTS,
  MVP_MODES,
  MindchestraError,
  MissionResultSchema,
  MissionSpecSchema,
  canonicalJson,
  isTerminalMissionStatus,
  sha256Hex,
  type AgentAdapter,
  type Claim,
  type EvidenceRef,
  type MissionResult,
  type MissionSnapshot,
  type MissionSpec,
  type MissionStatus,
  type Phase,
  type RunRequest,
  type UsageMetrics
} from '@mindchestra/contracts';
import type {
  AdapterRegistryPort,
  ArtifactPort,
  ClockPort,
  IdGeneratorPort,
  StoragePort,
  TrustedRunnerCheck,
  TrustedRunnerPort,
  WorkspacePort
} from './ports.js';
import { MissionAbortCoordinator, MissionBudgetTracker, Semaphore } from './scheduler.js';
import { PhaseMailbox } from './mailbox.js';
import { VerdictEngine } from './verdict.js';
import { TelemetryCollector } from './telemetry.js';

export interface MissionEngineDeps {
  storage: StoragePort;
  adapters: AdapterRegistryPort;
  workspaces: WorkspacePort;
  artifacts: ArtifactPort;
  trustedRunner?: TrustedRunnerPort;
  clock?: ClockPort;
  ids?: IdGeneratorPort;
}

interface ParsedAgentOutput {
  claims: Array<{ text: string; severity?: Claim['severity']; confidence?: number }>;
  evidence: Array<{ sourceRef: string; relation?: EvidenceRef['relation']; kind?: EvidenceRef['kind'] }>;
}

interface SingleRunOutcome {
  runId: string;
  agentId: string;
  succeeded: boolean;
  cancelled: boolean;
  summary: string;
  claims: Claim[];
  latestUsage?: UsageMetrics;
}

const DEFAULT_CLOCK: ClockPort = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString()
};

function parseStructuredFindings(text: string): ParsedAgentOutput {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const claims: ParsedAgentOutput['claims'] = Array.isArray(parsed.claims)
        ? parsed.claims
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'))
            .map((item) => {
              const severity: Claim['severity'] =
                item.severity === 'info' ||
                item.severity === 'low' ||
                item.severity === 'medium' ||
                item.severity === 'high' ||
                item.severity === 'critical'
                  ? item.severity
                  : 'medium';
              return {
                text: String(item.text),
                severity,
                confidence: typeof item.confidence === 'number' ? item.confidence : undefined
              };
            })
        : [];
      const evidence: ParsedAgentOutput['evidence'] = Array.isArray(parsed.evidence)
        ? parsed.evidence
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).sourceRef === 'string'))
            .map((item) => {
              const relation: EvidenceRef['relation'] =
                item.relation === 'supports' ||
                item.relation === 'contradicts' ||
                item.relation === 'duplicates' ||
                item.relation === 'supersedes'
                  ? item.relation
                  : 'supports';
              const kind: EvidenceRef['kind'] =
                item.kind === 'source' ||
                item.kind === 'test' ||
                item.kind === 'tool' ||
                item.kind === 'artifact' ||
                item.kind === 'external'
                  ? item.kind
                  : 'source';
              return {
                sourceRef: String(item.sourceRef),
                relation,
                kind
              };
            })
        : [];
      return { claims, evidence };
    }
  } catch {
    
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { claims: [], evidence: [] };
  }
  return {
    claims: [{ text: trimmed.slice(0, 4000), severity: 'info' }],
    evidence: []
  };
}

export class MissionEngine {
  private readonly clock: ClockPort;
  private readonly ids: IdGeneratorPort;
  private readonly coordinator = new MissionAbortCoordinator();
  private readonly mailbox: PhaseMailbox;
  private readonly verdictEngine: VerdictEngine;
  private readonly telemetry = new TelemetryCollector();
  private readonly activeExecutions = new Map<string, Promise<MissionResult>>();

  constructor(private readonly deps: MissionEngineDeps) {
    this.clock = deps.clock ?? DEFAULT_CLOCK;
    this.ids = deps.ids ?? { nextId: () => randomUUID() };
    this.mailbox = new PhaseMailbox(deps.storage, this.clock, this.ids);
    this.verdictEngine = new VerdictEngine(deps.storage, deps.artifacts, this.ids);
  }

  getMailbox(): PhaseMailbox {
    return this.mailbox;
  }

  getTelemetry(): TelemetryCollector {
    return this.telemetry;
  }

  createMission(
    rawSpec: unknown,
    options?: {
      callerScope?: string;
      idempotencyKey?: string;
      correlationId?: string;
      parentMissionId?: string;
    }
  ): { snapshot: MissionSnapshot; deduplicated: boolean } {
    const parsed = MissionSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      throw new MindchestraError('INVALID_INPUT', 'Invalid MissionSpec', {
        details: { issues: parsed.error.issues }
      });
    }
    const spec = parsed.data;

    if (!MVP_MODES.includes(spec.mode as (typeof MVP_MODES)[number])) {
      throw new MindchestraError('UNSUPPORTED', `Mode '${spec.mode}' is not supported in v0.1`);
    }

    if (spec.agents.length > MAX_MVP_AGENTS) {
      throw new MindchestraError('INVALID_INPUT', `v0.1 supports at most ${MAX_MVP_AGENTS} agents per mission`);
    }

    for (const agentId of spec.agents) {
      if (!this.deps.adapters.getAdapter(agentId)) {
        throw new MindchestraError('NOT_FOUND', `Agent adapter '${agentId}' is not registered`);
      }
    }

    const workspace = this.deps.workspaces.resolveWorkspace(spec.workspace);
    const requestHash = sha256Hex(canonicalJson(spec));

    return this.deps.storage.createMissionWithIdempotency({
      missionId: this.ids.nextId(),
      spec,
      callerScope: options?.callerScope ?? 'local-user',
      idempotencyKey: options?.idempotencyKey,
      requestHash,
      correlationId: options?.correlationId ?? this.ids.nextId(),
      baseCommit: workspace.baseCommit,
      parentMissionId: options?.parentMissionId,
      nowIso: this.clock.nowIso()
    });
  }

  startMission(missionId: string, correlationId = this.ids.nextId()): Promise<MissionResult> {
    const existingPromise = this.activeExecutions.get(missionId);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = this.executeMission(missionId, correlationId).finally(() => {
      this.activeExecutions.delete(missionId);
      this.coordinator.cleanupMission(missionId);
    });
    this.activeExecutions.set(missionId, promise);
    return promise;
  }

  async cancelMission(missionId: string, correlationId = this.ids.nextId()): Promise<MissionSnapshot> {
    const snapshot = this.deps.storage.getMissionSnapshot(missionId);
    if (isTerminalMissionStatus(snapshot.status)) {
      return snapshot;
    }

    if (snapshot.status === 'queued') {
      const nowIso = this.clock.nowIso();
      const result = MissionResultSchema.parse({
        missionId,
        status: 'cancelled',
        summary: 'Mission cancelled before execution began.',
        claims: [],
        evidence: [],
        verdicts: [],
        artifactIds: [],
        unresolved: ['Mission cancelled by user']
      });
      this.deps.storage.appendEvent({
        missionId,
        actor: 'daemon',
        correlationId,
        at: nowIso,
        payload: {
          type: 'mission.status',
          payload: { status: 'cancelled' }
        },
        missionUpdate: {
          status: 'cancelled',
          phase: 'finalize',
          result
        }
      });
      return this.deps.storage.getMissionSnapshot(missionId);
    }

    if (snapshot.status !== 'cancel_requested') {
      this.deps.storage.appendEvent({
        missionId,
        actor: 'daemon',
        correlationId,
        at: this.clock.nowIso(),
        payload: {
          type: 'mission.status',
          payload: { status: 'cancel_requested' }
        },
        missionUpdate: {
          status: 'cancel_requested'
        }
      });
    }

    this.coordinator.abortMission(missionId);
    return this.deps.storage.getMissionSnapshot(missionId);
  }

  async waitForMission(missionId: string): Promise<MissionResult> {
    const active = this.activeExecutions.get(missionId);
    if (active) {
      return active;
    }
    return this.deps.storage.getMissionResult(missionId);
  }

  async shutdown(): Promise<void> {
    const activeEntries = [...this.activeExecutions.entries()];
    for (const [missionId] of activeEntries) {
      this.coordinator.abortMission(missionId, 'Daemon shutting down');
    }
    if (activeEntries.length > 0) {
      await Promise.allSettled(activeEntries.map(([, execution]) => execution));
    }
  }

  private transitionPhase(missionId: string, phase: Phase, correlationId: string): void {
    this.deps.storage.appendEvent({
      missionId,
      actor: 'daemon',
      correlationId,
      at: this.clock.nowIso(),
      payload: {
        type: 'mission.phase',
        payload: { phase }
      },
      missionUpdate: {
        phase
      }
    });
  }

  private async executeMission(missionId: string, correlationId: string): Promise<MissionResult> {
    const snapshot = this.deps.storage.getMissionSnapshot(missionId);
    const spec: MissionSpec = snapshot.spec;
    const workspace = this.deps.workspaces.resolveWorkspace(spec.workspace);
    const deadlineMs = this.clock.now().getTime() + spec.budget.maxSeconds * 1000;
    const deadlineAt = new Date(deadlineMs).toISOString();
    const budgetTracker = new MissionBudgetTracker(spec.budget, deadlineMs, this.clock);
    const semaphore = new Semaphore(spec.budget.maxConcurrency);
    const controller = this.coordinator.createController(missionId);

    const timer = setTimeout(() => {
      controller.abort(new MindchestraError('TIMEOUT', 'Mission deadline reached'));
    }, Math.max(1, budgetTracker.getRemainingMs()));

    try {
      this.deps.storage.appendEvent({
        missionId,
        actor: 'daemon',
        correlationId,
        at: this.clock.nowIso(),
        payload: {
          type: 'mission.status',
          payload: { status: 'running' }
        },
        missionUpdate: {
          status: 'running',
          phase: 'prepare'
        }
      });

      this.transitionPhase(missionId, 'independent', correlationId);
      budgetTracker.allocateRound();

      const independentOutcomes = await Promise.all(
        spec.agents.map((agentId) =>
          semaphore.withPermit(controller.signal, () =>
            this.runSingleAgent({
              missionId,
              spec,
              agentId,
              phase: 'independent',
              prompt: this.buildIndependentPrompt(spec),
              workspacePath: workspace.canonicalPath,
              baseCommit: workspace.baseCommit,
              deadlineAt,
              correlationId,
              budgetTracker,
              signal: controller.signal
            })
          )
        )
      );

      const allOutcomes: SingleRunOutcome[] = [...independentOutcomes];
      const independentSucceeded = independentOutcomes.filter((o) => o.succeeded);

      if (
        !controller.signal.aborted &&
        (spec.mode === 'council' || spec.mode === 'review') &&
        independentSucceeded.length > 0 &&
        spec.budget.maxRounds >= 2
      ) {
        this.transitionPhase(missionId, 'critique', correlationId);
        budgetTracker.allocateRound();

        const critiquePrompt = this.buildCritiquePrompt(spec, independentOutcomes);
        const critiqueOutcomes = await Promise.all(
          independentSucceeded.map((prior) =>
            semaphore.withPermit(controller.signal, () =>
              this.runSingleAgent({
                missionId,
                spec,
                agentId: prior.agentId,
                phase: 'critique',
                prompt: critiquePrompt,
                workspacePath: workspace.canonicalPath,
                baseCommit: workspace.baseCommit,
                deadlineAt,
                correlationId,
                budgetTracker,
                signal: controller.signal
              })
            )
          )
        );
        allOutcomes.push(...critiqueOutcomes);
      }

      this.transitionPhase(missionId, 'verify', correlationId);

      let trustedChecks: TrustedRunnerCheck[] = [];
      if (this.deps.trustedRunner && !controller.signal.aborted) {
        trustedChecks = await this.deps.trustedRunner.runVerification({
          missionId,
          workspacePath: workspace.canonicalPath,
          baseCommit: workspace.baseCommit,
          candidateArtifactId: spec.candidateArtifactId
        });

        const claims = this.deps.storage.listClaimsByMission(missionId);
        const anchorClaimId = claims[0]?.id;
        if (anchorClaimId) {
          for (const check of trustedChecks) {
            const ev = EvidenceRefSchema.parse({
              id: this.ids.nextId(),
              missionId,
              claimId: anchorClaimId,
              kind: 'test',
              relation: check.passed ? 'supports' : 'contradicts',
              sourceRef: check.sourceRef,
              ...(check.artifactId ? { artifactId: check.artifactId } : {}),
              ...(check.sha256 ? { sha256: check.sha256 } : {}),
              ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
              ...(check.toolVersion ? { toolVersion: check.toolVersion } : {}),
              at: this.clock.nowIso(),
              provenance: 'trusted_runner',
              status: check.passed ? 'verified' : 'rejected'
            });
            this.deps.storage.insertEvidence(ev);
            this.deps.storage.appendEvent({
              missionId,
              actor: 'daemon',
              correlationId,
              at: ev.at,
              payload: { type: 'evidence.added', payload: ev }
            });
          }
        }
      }

      const verdict = this.verdictEngine.evaluateMission({
        missionId,
        correlationId,
        rubricId: spec.rubricId,
        candidateArtifactId: spec.candidateArtifactId,
        trustedChecks,
        nowIso: this.clock.nowIso()
      });

      if (spec.mode === 'council') {
        this.transitionPhase(missionId, 'synthesize', correlationId);
      }

      this.transitionPhase(missionId, 'finalize', correlationId);

      const finalStatus = this.determineTerminalStatus(allOutcomes, controller.signal.aborted, budgetTracker.isExpired());
      const claims = this.deps.storage.listClaimsByMission(missionId);
      const evidence = this.deps.storage.listEvidenceByMission(missionId);
      const verdicts = this.deps.storage.listVerdictsByMission(missionId);

      const unresolved: string[] = [...verdict.dissent, ...budgetTracker.getWarnings()];
      for (const failed of allOutcomes.filter((o) => !o.succeeded)) {
        unresolved.push(`Run ${failed.runId} (${failed.agentId}): ${failed.summary}`);
      }

      const summaryParts = [
        `Mode ${spec.mode} completed with status ${finalStatus}.`,
        `Agents succeeded: ${independentSucceeded.length}/${independentOutcomes.length}.`,
        `Verdict: ${verdict.status} (${verdict.reason}).`
      ];

      const summaryArtifact = this.deps.artifacts.putArtifact({
        missionId,
        contentType: 'application/json',
        content: JSON.stringify(
          {
            missionId,
            status: finalStatus,
            verdict,
            claims,
            evidence,
            runs: allOutcomes.map((o) => ({
              runId: o.runId,
              agentId: o.agentId,
              succeeded: o.succeeded,
              summary: o.summary
            }))
          },
          null,
          2
        )
      });

      const result = MissionResultSchema.parse({
        missionId,
        status: finalStatus,
        summary: summaryParts.join(' '),
        claims: claims.map((c) => c.id),
        evidence: evidence.map((e) => e.id),
        verdicts: verdicts.map((v) => v.id),
        artifactIds: [summaryArtifact.id],
        unresolved
      });

      const finalAt = this.clock.nowIso();
      this.deps.storage.appendEvent({
        missionId,
        actor: 'daemon',
        correlationId,
        at: finalAt,
        payload: {
          type: 'mission.result',
          payload: result
        },
        missionUpdate: {
          status: finalStatus,
          phase: 'finalize',
          result
        }
      });

      return result;
    } catch (error) {
      const current = this.deps.storage.getMissionSnapshot(missionId);
      if (isTerminalMissionStatus(current.status)) {
        return this.deps.storage.getMissionResult(missionId);
      }
      const fallbackStatus: MissionStatus = controller.signal.aborted
        ? budgetTracker.isExpired()
          ? 'failed'
          : 'cancelled'
        : 'failed';
      const message = error instanceof Error ? error.message : 'Mission execution failed';
      const result = MissionResultSchema.parse({
        missionId,
        status: fallbackStatus,
        summary: message,
        claims: this.deps.storage.listClaimsByMission(missionId).map((c) => c.id),
        evidence: this.deps.storage.listEvidenceByMission(missionId).map((e) => e.id),
        verdicts: this.deps.storage.listVerdictsByMission(missionId).map((v) => v.id),
        artifactIds: [],
        unresolved: [message]
      });

      this.deps.storage.appendEvent({
        missionId,
        actor: 'daemon',
        correlationId,
        at: this.clock.nowIso(),
        payload: {
          type: 'mission.result',
          payload: result
        },
        missionUpdate: {
          status: fallbackStatus,
          phase: 'finalize',
          result
        }
      });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runSingleAgent(input: {
    missionId: string;
    spec: MissionSpec;
    agentId: string;
    phase: Phase;
    prompt: string;
    workspacePath: string;
    baseCommit?: string;
    deadlineAt: string;
    correlationId: string;
    budgetTracker: MissionBudgetTracker;
    signal: AbortSignal;
  }): Promise<SingleRunOutcome> {
    const runId = this.ids.nextId();
    const startedAt = this.clock.nowIso();

    if (input.signal.aborted) {
      return {
        runId,
        agentId: input.agentId,
        succeeded: false,
        cancelled: true,
        summary: 'Cancelled before run started',
        claims: []
      };
    }

    try {
      input.budgetTracker.allocateRun();
    } catch (error) {
      return {
        runId,
        agentId: input.agentId,
        succeeded: false,
        cancelled: false,
        summary: error instanceof Error ? error.message : 'Run budget exhausted',
        claims: []
      };
    }

    const adapter = this.deps.adapters.getAdapter(input.agentId);
    if (!adapter) {
      return {
        runId,
        agentId: input.agentId,
        succeeded: false,
        cancelled: false,
        summary: `Adapter ${input.agentId} missing`,
        claims: []
      };
    }

    this.deps.storage.insertRun({
      id: runId,
      missionId: input.missionId,
      agentId: input.agentId,
      phase: input.phase,
      status: 'running',
      startedAt
    });

    const req: RunRequest = {
      missionId: input.missionId,
      runId,
      agentId: input.agentId,
      phase: input.phase,
      prompt: input.prompt,
      workspacePath: input.workspacePath,
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      profile: input.spec.profile,
      deadlineAt: input.deadlineAt,
      toolGrantIds: [],
      inputArtifactIds: input.spec.inputArtifactIds ?? []
    };

    const deltaSeen = new Map<string, string>();
    const completedMessages: string[] = [];
    let terminalReceived = false;
    let succeeded = false;
    let summary = '';
    let latestUsage: UsageMetrics | undefined;

    try {
      for await (const rawEvent of adapter.run(req, input.signal)) {
        const parsed = AdapterEventSchema.safeParse(rawEvent);
        if (!parsed.success) {
          continue;
        }
        const event = parsed.data;

        if (terminalReceived) {
          continue;
        }

        if (event.type === 'message.delta') {
          const prev = deltaSeen.get(event.payload.messageId) ?? '';
          const nextText = prev + event.payload.text;
          if (event.payload.text.length === 0) {
            continue;
          }
          deltaSeen.set(event.payload.messageId, nextText);
        } else if (event.type === 'message.completed') {
          completedMessages.push(event.payload.text);
        } else if (event.type === 'usage.updated') {
          latestUsage = event.payload;
          this.telemetry.recordRunUsage(runId, event.payload);
          input.budgetTracker.recordRunUsage(runId, event.payload);
        } else if (event.type === 'agent.started' && event.payload.providerSessionId) {
          this.deps.storage.updateRun(runId, { sessionId: event.payload.providerSessionId });
        } else if (event.type === 'agent.finished') {
          terminalReceived = true;
          succeeded = true;
          summary = event.payload.summary;
        } else if (event.type === 'agent.failed') {
          terminalReceived = true;
          succeeded = false;
          summary = event.payload.message;
        }

        this.deps.storage.appendEvent({
          missionId: input.missionId,
          actor: input.agentId,
          correlationId: input.correlationId,
          runId,
          at: this.clock.nowIso(),
          payload: event
        });
      }

      if (!terminalReceived) {
        if (input.signal.aborted) {
          succeeded = false;
          summary = 'Run aborted';
          this.deps.storage.appendEvent({
            missionId: input.missionId,
            actor: 'daemon',
            correlationId: input.correlationId,
            runId,
            at: this.clock.nowIso(),
            payload: {
              type: 'agent.failed',
              payload: {
                code: input.budgetTracker.isExpired() ? 'TIMEOUT' : 'CANCELLED',
                message: summary,
                retryable: false
              }
            }
          });
        } else {
          succeeded = true;
          summary = completedMessages[completedMessages.length - 1]?.slice(0, 200) || 'Run completed';
          this.deps.storage.appendEvent({
            missionId: input.missionId,
            actor: 'daemon',
            correlationId: input.correlationId,
            runId,
            at: this.clock.nowIso(),
            payload: {
              type: 'agent.finished',
              payload: { summary }
            }
          });
        }
      }
    } catch (error) {
      succeeded = false;
      const errCode = input.signal.aborted
        ? input.budgetTracker.isExpired()
          ? 'TIMEOUT'
          : 'CANCELLED'
        : error instanceof MindchestraError
          ? error.code
          : 'INTERNAL';
      summary = error instanceof Error ? error.message : 'Adapter run failed';
      if (!terminalReceived) {
        this.deps.storage.appendEvent({
          missionId: input.missionId,
          actor: 'daemon',
          correlationId: input.correlationId,
          runId,
          at: this.clock.nowIso(),
          payload: {
            type: 'agent.failed',
            payload: {
              code: errCode,
              message: summary,
              retryable: errCode === 'TIMEOUT' || errCode === 'RATE_LIMITED'
            }
          }
        });
      }
    }

    const cancelled = input.signal.aborted && !input.budgetTracker.isExpired();
    this.coordinator.recordAgentOutcome(input.agentId, succeeded);
    this.deps.storage.updateRun(runId, {
      status: cancelled ? 'cancelled' : succeeded ? 'finished' : 'failed',
      summary,
      usage: latestUsage,
      endedAt: this.clock.nowIso()
    });

    const createdClaims: Claim[] = [];
    const authoritativeText = completedMessages[completedMessages.length - 1] ?? (succeeded ? summary : '');
    if (succeeded && authoritativeText.length > 0) {
      const parsed = parseStructuredFindings(authoritativeText);
      for (const rawClaim of parsed.claims) {
        const claim = ClaimSchema.parse({
          id: this.ids.nextId(),
          missionId: input.missionId,
          runId,
          text: rawClaim.text,
          severity: rawClaim.severity ?? 'medium',
          status: 'unverified',
          ...(rawClaim.confidence !== undefined ? { confidence: rawClaim.confidence } : {})
        });
        this.deps.storage.insertClaim(claim, this.clock.nowIso());
        this.deps.storage.appendEvent({
          missionId: input.missionId,
          actor: input.agentId,
          correlationId: input.correlationId,
          runId,
          at: this.clock.nowIso(),
          payload: { type: 'claim.created', payload: claim }
        });
        createdClaims.push(claim);
      }

      const anchorClaimId = createdClaims[0]?.id;
      if (anchorClaimId) {
        for (const rawEv of parsed.evidence) {
          if (!this.deps.workspaces.validateSourceRef(input.workspacePath, rawEv.sourceRef)) {
            continue;
          }
          const ev = EvidenceRefSchema.parse({
            id: this.ids.nextId(),
            missionId: input.missionId,
            claimId: anchorClaimId,
            kind: rawEv.kind ?? 'source',
            relation: rawEv.relation ?? 'supports',
            sourceRef: rawEv.sourceRef,
            ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
            at: this.clock.nowIso(),
            provenance: 'agent_report',
            status: 'unverified'
          });
          this.deps.storage.insertEvidence(ev);
          this.deps.storage.appendEvent({
            missionId: input.missionId,
            actor: input.agentId,
            correlationId: input.correlationId,
            runId,
            at: ev.at,
            payload: { type: 'evidence.added', payload: ev }
          });
        }
      }
    }

    return {
      runId,
      agentId: input.agentId,
      succeeded,
      cancelled,
      summary,
      claims: createdClaims,
      latestUsage
    };
  }

  private determineTerminalStatus(
    outcomes: SingleRunOutcome[],
    aborted: boolean,
    expired: boolean
  ): MissionStatus {
    if (aborted && !expired) {
      return 'cancelled';
    }
    const independentRuns = outcomes.filter((o) => o.succeeded || !o.cancelled);
    const succeededCount = independentRuns.filter((o) => o.succeeded).length;
    if (succeededCount === 0) {
      return 'failed';
    }
    if (succeededCount < independentRuns.length) {
      return 'partial';
    }
    return 'completed';
  }

  private buildIndependentPrompt(spec: MissionSpec): string {
    return [
      `Objective: ${spec.objective}`,
      `Mode: ${spec.mode}`,
      `Profile: ${spec.profile}`,
      spec.candidateArtifactId ? `Candidate Artifact: ${spec.candidateArtifactId}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildCritiquePrompt(spec: MissionSpec, priorOutcomes: SingleRunOutcome[]): string {
    const peerFindings = priorOutcomes
      .map((outcome) => {
        const claimLines = outcome.claims.map((c) => `  - [${c.id}] (${c.severity}) ${c.text}`).join('\n');
        return `Agent ${outcome.agentId} (${outcome.succeeded ? 'ok' : 'failed'}):\n${claimLines || `  - ${outcome.summary}`}`;
      })
      .join('\n\n');

    return [
      `Critique Phase for Objective: ${spec.objective}`,
      'Independent phase findings:',
      peerFindings
    ].join('\n\n');
  }
}
