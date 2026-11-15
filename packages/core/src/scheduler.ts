import { MindchestraError, type Budget, type UsageMetrics } from '@mindchestra/contracts';
import type { ClockPort } from './ports.js';

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new MindchestraError('INVALID_INPUT', 'Concurrency limit must be at least 1');
    }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new MindchestraError('CANCELLED', 'Operation cancelled while waiting for concurrency slot');
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(grant);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new MindchestraError('CANCELLED', 'Operation cancelled while queued for concurrency slot'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  async withPermit<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class MissionBudgetTracker {
  private runsStarted = 0;
  private roundsCompleted = 0;
  private toolCallsUsed = 0;
  private readonly runUsage = new Map<string, UsageMetrics>();
  private readonly unmeasuredWarnings: string[] = [];

  constructor(
    readonly budget: Budget,
    private readonly deadlineMs: number,
    private readonly clock: ClockPort
  ) {}

  getRemainingMs(): number {
    return Math.max(0, this.deadlineMs - this.clock.now().getTime());
  }

  isExpired(): boolean {
    return this.clock.now().getTime() >= this.deadlineMs;
  }

  assertTimeRemaining(): void {
    if (this.isExpired()) {
      throw new MindchestraError('TIMEOUT', 'Mission time budget exceeded');
    }
  }

  allocateRun(): number {
    this.assertTimeRemaining();
    if (this.runsStarted >= this.budget.maxRuns) {
      throw new MindchestraError('RATE_LIMITED', `Mission maxRuns budget (${this.budget.maxRuns}) exceeded`);
    }
    this.runsStarted += 1;
    return this.runsStarted;
  }

  allocateRound(): number {
    this.assertTimeRemaining();
    if (this.roundsCompleted >= this.budget.maxRounds) {
      throw new MindchestraError('RATE_LIMITED', `Mission maxRounds budget (${this.budget.maxRounds}) exceeded`);
    }
    this.roundsCompleted += 1;
    return this.roundsCompleted;
  }

  allocateToolCall(): number {
    this.assertTimeRemaining();
    if (this.toolCallsUsed >= this.budget.maxToolCalls) {
      throw new MindchestraError('RATE_LIMITED', `Mission maxToolCalls budget (${this.budget.maxToolCalls}) exceeded`);
    }
    this.toolCallsUsed += 1;
    return this.toolCallsUsed;
  }

  recordRunUsage(runId: string, metrics: UsageMetrics): void {
    this.runUsage.set(runId, metrics);
    if (
      this.budget.maxTokens !== undefined &&
      (metrics.source === 'unknown' || metrics.inputTokens === null || metrics.outputTokens === null)
    ) {
      const warning = `Token usage for run ${runId} is unmeasured; maxTokens cannot be strictly enforced`;
      if (!this.unmeasuredWarnings.includes(warning)) {
        this.unmeasuredWarnings.push(warning);
      }
      return;
    }

    if (this.budget.maxTokens !== undefined) {
      const total = this.getTotalTokens();
      if (total !== null && total > this.budget.maxTokens) {
        throw new MindchestraError('RATE_LIMITED', `Mission maxTokens budget (${this.budget.maxTokens}) exceeded`);
      }
    }
  }

  getTotalTokens(): number | null {
    let total = 0;
    let hasMeasured = false;
    for (const metrics of this.runUsage.values()) {
      if (metrics.inputTokens !== null || metrics.outputTokens !== null) {
        hasMeasured = true;
        total += (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0);
      }
    }
    return hasMeasured ? total : null;
  }

  getWarnings(): string[] {
    return [...this.unmeasuredWarnings];
  }

  getSnapshot(): {
    runsStarted: number;
    roundsCompleted: number;
    toolCallsUsed: number;
    totalTokens: number | null;
  } {
    return {
      runsStarted: this.runsStarted,
      roundsCompleted: this.roundsCompleted,
      toolCallsUsed: this.toolCallsUsed,
      totalTokens: this.getTotalTokens()
    };
  }
}

export class MissionAbortCoordinator {
  private readonly missionControllers = new Map<string, AbortController>();
  private readonly consecutiveFailures = new Map<string, number>();

  createController(missionId: string): AbortController {
    const controller = new AbortController();
    this.missionControllers.set(missionId, controller);
    return controller;
  }

  getController(missionId: string): AbortController | undefined {
    return this.missionControllers.get(missionId);
  }

  abortMission(missionId: string, reason = 'Mission cancelled'): boolean {
    const controller = this.missionControllers.get(missionId);
    if (!controller) {
      return false;
    }
    if (!controller.signal.aborted) {
      controller.abort(new MindchestraError('CANCELLED', reason));
    }
    return true;
  }

  cleanupMission(missionId: string): void {
    this.missionControllers.delete(missionId);
  }

  recordAgentOutcome(agentId: string, succeeded: boolean): void {
    if (succeeded) {
      this.consecutiveFailures.set(agentId, 0);
      return;
    }
    const next = (this.consecutiveFailures.get(agentId) ?? 0) + 1;
    this.consecutiveFailures.set(agentId, next);
  }

  getConsecutiveFailures(agentId: string): number {
    return this.consecutiveFailures.get(agentId) ?? 0;
  }
}
