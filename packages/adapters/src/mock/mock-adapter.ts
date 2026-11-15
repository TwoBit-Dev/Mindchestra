import { randomUUID } from 'node:crypto';
import { BaseAgentAdapter } from '@mindchestra/adapter-sdk';
import {
  DEFAULT_FALSE_CAPABILITIES,
  type AdapterEvent,
  type AgentCapabilities,
  type AgentManifest,
  type ErrorResponse,
  type ProbeResult,
  type ProbeStatus,
  type RunRequest
} from '@mindchestra/contracts';

export interface MockAdapterOptions {
  id?: string;
  displayName?: string;
  probeStatus?: ProbeStatus;
  capabilities?: Partial<AgentCapabilities>;
  chunks?: string[];
  delayMs?: number;
  toolObserved?: { name: string; detail?: string };
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number | null; durationMs: number };
  shouldFail?: boolean;
  failureError?: ErrorResponse;
  summary?: string;
}

export class DeterministicMockAdapter extends BaseAgentAdapter {
  private readonly options: MockAdapterOptions;

  constructor(options: MockAdapterOptions = {}) {
    const id = options.id ?? 'mock-agent';
    const manifest: AgentManifest = {
      id,
      displayName: options.displayName ?? `Deterministic Mock (${id})`,
      provider: 'mock',
      adapterVersion: '0.1.0',
      sdkVersion: 1,
      kind: 'custom',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: true,
        usage: true,
        ...options.capabilities
      }
    };

    super(manifest);
    this.options = options;
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    this.assertNotAborted(signal);
    return {
      status: this.options.probeStatus ?? 'ready',
      checkedAt: new Date().toISOString(),
      version: '0.1.0',
      detail: 'Deterministic mock adapter probe verified',
      capabilities: this._manifest.capabilities
    };
  }

  async *run(req: RunRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.assertNotAborted(signal);

    const sessionId = req.sessionId ?? randomUUID();
    yield {
      type: 'agent.started',
      payload: { providerSessionId: sessionId }
    };

    const messageId = randomUUID();
    const chunks = this.options.chunks ?? [
      'Analyzing task constraints and input artifacts... ',
      'Verified deterministic findings against local baseline. ',
      'Conclusion generated without external network dependencies.'
    ];

    let accumulatedText = '';
    for (const chunk of chunks) {
      this.assertNotAborted(signal);
      if (this.options.delayMs && this.options.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.options.delayMs));
      }
      accumulatedText += chunk;
      yield {
        type: 'message.delta',
        payload: {
          messageId,
          text: chunk
        }
      };
    }

    yield {
      type: 'message.completed',
      payload: {
        messageId,
        text: accumulatedText
      }
    };

    if (this.options.toolObserved) {
      this.assertNotAborted(signal);
      yield {
        type: 'tool.observed',
        payload: {
          name: this.options.toolObserved.name,
          detail: this.options.toolObserved.detail
        }
      };
    }

    if (this.options.usage !== null) {
      this.assertNotAborted(signal);
      const usage = this.options.usage ?? {
        inputTokens: 120,
        outputTokens: 85,
        costUsd: null,
        durationMs: 42
      };
      yield {
        type: 'usage.updated',
        payload: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd ?? null,
          durationMs: usage.durationMs,
          source: 'measured'
        }
      };
    }

    this.assertNotAborted(signal);
    if (this.options.shouldFail) {
      const err = this.options.failureError ?? {
        code: 'INTERNAL',
        message: 'Deterministic simulated failure triggered',
        retryable: false
      };
      yield {
        type: 'agent.failed',
        payload: err
      };
    } else {
      yield {
        type: 'agent.finished',
        payload: {
          summary: this.options.summary ?? 'Deterministic mock run successfully completed.'
        }
      };
    }
  }
}
