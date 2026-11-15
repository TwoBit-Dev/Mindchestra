import type { AgentCapabilities, AgentManifest, Id, ProbeResult } from './agents.js';
import type { AdapterEvent } from './events.js';
import type { ResumeRequest, RunRequest } from './missions.js';

export interface AgentAdapter {
  manifest(): AgentManifest;
  probe(signal: AbortSignal): Promise<ProbeResult>;
  capabilities(): Promise<AgentCapabilities>;
  run(req: RunRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  resume?(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  cancel?(runId: Id): Promise<void>;
}
