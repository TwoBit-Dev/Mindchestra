import {
  AgentManifestSchema,
  MindchestraError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentManifest,
  type AdapterEvent,
  type Id,
  type ProbeResult,
  type ResumeRequest,
  type RunRequest
} from '@mindchestra/contracts';

/**
 * Abstract base class providing lifecycle management, validation, and error wrapping
 * for all Mindchestra Agent Adapters.
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected readonly _manifest: AgentManifest;

  constructor(manifest: AgentManifest) {
    // Validate manifest against canonical schema on construction
    this._manifest = Object.freeze(AgentManifestSchema.parse(manifest));
    if (this._manifest.sdkVersion !== 1) {
      throw new MindchestraError(
        'INVALID_INPUT',
        `Unsupported SDK version: ${this._manifest.sdkVersion}. Only sdkVersion 1 is supported.`
      );
    }
  }

  manifest(): AgentManifest {
    return this._manifest;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return this._manifest.capabilities;
  }

  abstract probe(signal: AbortSignal): Promise<ProbeResult>;

  abstract run(req: RunRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;

  resume?(req: ResumeRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;

  cancel?(runId: Id): Promise<void>;

  /**
   * Helper to check abort signal and throw CANCELLED error if aborted.
   */
  protected assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new MindchestraError('CANCELLED', 'Operation was aborted by signal');
    }
  }

  /**
   * Normalizes unknown errors into a canonical MindchestraError.
   */
  protected wrapError(error: unknown, fallbackMessage = 'Adapter operation failed'): MindchestraError {
    if (error instanceof MindchestraError) {
      return error;
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return new MindchestraError('CANCELLED', 'Adapter operation was aborted');
      }
      return new MindchestraError('INTERNAL', error.message);
    }
    return new MindchestraError('INTERNAL', `${fallbackMessage}: ${String(error)}`);
  }
}
