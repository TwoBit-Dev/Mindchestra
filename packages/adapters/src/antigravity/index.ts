import { BaseAgentAdapter } from '@mindchestra/adapter-sdk';
import {
  DEFAULT_FALSE_CAPABILITIES,
  MindchestraError,
  type AdapterEvent,
  type AgentManifest,
  type ProbeResult,
  type RunRequest
} from '@mindchestra/contracts';

export class AntigravityCliAdapter extends BaseAgentAdapter {
  constructor() {
    const manifest: AgentManifest = {
      id: 'antigravity',
      displayName: 'Antigravity CLI (agy)',
      provider: 'google',
      adapterVersion: '0.1.0',
      sdkVersion: 1,
      kind: 'cli',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: true,
        steer: true,
        resume: true,
        structuredOutput: true
      },
      models: ['gemini-2.5-pro', 'gemini-2.5-flash']
    };
    super(manifest);
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    this.assertNotAborted(signal);
    return {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      version: '0.1.0-beta',
      detail: 'Antigravity CLI adapter beta registered',
      capabilities: this._manifest.capabilities
    };
  }

  async *run(_req: RunRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new MindchestraError('UNSUPPORTED', 'Antigravity CLI adapter execution scheduled for Sprint 5');
  }
}
