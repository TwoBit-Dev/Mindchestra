import { randomUUID } from 'node:crypto';
import { BaseAgentAdapter } from '@mindchestra/adapter-sdk';
import {
  DEFAULT_FALSE_CAPABILITIES,
  type AdapterEvent,
  type AgentManifest,
  type ProbeResult,
  type RunRequest
} from '@mindchestra/contracts';

/**
 * Example Echo Adapter demonstrating the minimum required contract implementation.
 */
export class EchoCustomAdapter extends BaseAgentAdapter {
  constructor(id = 'echo-custom') {
    const manifest: AgentManifest = {
      id,
      displayName: `Echo Adapter (${id})`,
      provider: 'custom-example',
      adapterVersion: '0.1.0',
      sdkVersion: 1,
      kind: 'custom',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: false,
        usage: true
      }
    };
    super(manifest);
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    this.assertNotAborted(signal);
    return {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      version: '0.1.0',
      detail: 'Echo example adapter ready',
      capabilities: this._manifest.capabilities
    };
  }

  async *run(req: RunRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.assertNotAborted(signal);

    yield {
      type: 'agent.started',
      payload: { providerSessionId: req.sessionId ?? randomUUID() }
    };

    const messageId = randomUUID();
    const echoText = `Echo: ${req.prompt}`;

    yield {
      type: 'message.delta',
      payload: { messageId, text: echoText }
    };

    yield {
      type: 'message.completed',
      payload: { messageId, text: echoText }
    };

    yield {
      type: 'usage.updated',
      payload: {
        inputTokens: req.prompt.length,
        outputTokens: echoText.length,
        costUsd: null,
        durationMs: 5,
        source: 'measured'
      }
    };

    yield {
      type: 'agent.finished',
      payload: { summary: 'Echo run finished successfully.' }
    };
  }
}
