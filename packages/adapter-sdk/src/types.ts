import type {
  AgentAdapter,
  AgentCapabilities,
  AgentManifest,
  ProbeResult,
  ProbeStatus,
  AdapterEvent,
  RunRequest,
  ResumeRequest,
  Id,
  SlugId,
  ISOTime
} from '@mindchestra/contracts';

export type {
  AgentAdapter,
  AgentCapabilities,
  AgentManifest,
  ProbeResult,
  ProbeStatus,
  AdapterEvent,
  RunRequest,
  ResumeRequest,
  Id,
  SlugId,
  ISOTime
};

export interface CliRunnerOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxLineBytes?: number;
}

export interface CliProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface ConformanceCheckResult {
  name: string;
  passed: boolean;
  message?: string;
}

export interface ConformanceReport {
  adapterId: string;
  passed: boolean;
  checks: ConformanceCheckResult[];
}
