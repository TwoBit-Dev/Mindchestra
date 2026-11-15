import { describe, expect, it } from 'vitest';
import { DeterministicMockAdapter } from '@mindchestra/adapters';
import type { AdapterEvent, RunRequest } from '@mindchestra/contracts';

describe('DeterministicMockAdapter', () => {
  const req: RunRequest = {
    missionId: '10000000-0000-0000-0000-000000000001',
    runId: '20000000-0000-0000-0000-000000000002',
    agentId: 'mock-agent',
    phase: 'independent',
    prompt: 'Review architecture invariant',
    workspacePath: '/tmp/test',
    profile: 'read-only',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    toolGrantIds: [],
    inputArtifactIds: []
  };

  it('yields ordered stream of events with finished terminal state', async () => {
    const adapter = new DeterministicMockAdapter({
      chunks: ['Part 1', 'Part 2'],
      toolObserved: { name: 'git_status', detail: 'clean' },
      summary: 'Task completed'
    });

    const events: AdapterEvent[] = [];
    const controller = new AbortController();

    for await (const ev of adapter.run(req, controller.signal)) {
      events.push(ev);
    }

    expect(events.length).toBe(7);
    expect(events[0]?.type).toBe('agent.started');
    expect(events[1]?.type).toBe('message.delta');
    expect(events[2]?.type).toBe('message.delta');
    expect(events[3]?.type).toBe('message.completed');
    expect(events[4]?.type).toBe('tool.observed');
    expect(events[5]?.type).toBe('usage.updated');
    expect(events[6]?.type).toBe('agent.finished');
  });

  it('yields agent.failed when shouldFail is true', async () => {
    const adapter = new DeterministicMockAdapter({
      shouldFail: true,
      failureError: {
        code: 'UNAVAILABLE',
        message: 'Provider quota exhausted',
        retryable: false
      }
    });

    const events: AdapterEvent[] = [];
    const controller = new AbortController();

    for await (const ev of adapter.run(req, controller.signal)) {
      events.push(ev);
    }

    const terminal = events[events.length - 1];
    expect(terminal?.type).toBe('agent.failed');
    if (terminal?.type === 'agent.failed') {
      expect(terminal.payload.code).toBe('UNAVAILABLE');
      expect(terminal.payload.message).toBe('Provider quota exhausted');
    }
  });

  it('aborts cleanly when AbortSignal is cancelled', async () => {
    const adapter = new DeterministicMockAdapter({ delayMs: 50 });
    const controller = new AbortController();

    const runPromise = (async () => {
      const events: AdapterEvent[] = [];
      for await (const ev of adapter.run(req, controller.signal)) {
        events.push(ev);
        controller.abort();
      }
      return events;
    })();

    await expect(runPromise).rejects.toThrow();
  });
});
