import { BaseAgentAdapter } from '@mindchestra/adapter-sdk';
import {
  DEFAULT_FALSE_CAPABILITIES,
  MindchestraError,
  type AdapterEvent,
  type AgentManifest,
  type ProbeResult,
  type RunRequest
} from '@mindchestra/contracts';

export class ClaudeCodeCliAdapter extends BaseAgentAdapter {
  constructor() {
    const manifest: AgentManifest = {
      id: 'claude',
      displayName: 'Claude Code CLI',
      provider: 'anthropic',
      adapterVersion: '0.1.0',
      sdkVersion: 1,
      kind: 'cli',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: true,
        vision: true,
        structuredOutput: true
      },
      models: ['claude-3-7-sonnet', 'claude-3-5-sonnet']
    };
    super(manifest);
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    this.assertNotAborted(signal);
    return {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      version: '0.1.0',
      detail: 'Claude Code CLI adapter stub registered',
      capabilities: this._manifest.capabilities
    };
  }

  async *run(_req: RunRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new MindchestraError('UNSUPPORTED', 'Claude Code CLI adapter execution scheduled for Sprint 4');
  }
}
