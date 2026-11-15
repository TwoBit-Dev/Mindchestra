import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { MindchestraError } from '@mindchestra/contracts';
import type { CliProcessResult, CliRunnerOptions } from './types.js';

const SENSITIVE_PATTERNS = [
  /([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)([^\s"';&]+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi,
  /(sk-[A-Za-z0-9_-]{20,})/gi,
  /(gh[pousr]_[A-Za-z0-9]{20,})/gi
];

export function redactSensitiveText(input: string): string {
  let redacted = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix, secret) => {
      if (secret !== undefined) {
        return `${prefix}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return redacted;
}

/**
 * Executes a CLI executable safely:
 * - spawn with argument array and shell: false strictly enforced
 * - UTF-8 chunk handling without multi-byte truncation
 * - Bounded line buffering
 * - Stderr redaction
 * - Timeout handling and process tree termination
 * - AbortSignal cancellation
 */
export async function* streamCliLines(
  options: CliRunnerOptions
): AsyncGenerator<string, CliProcessResult, void> {
  const {
    executable,
    args,
    cwd,
    env,
    timeoutMs,
    signal,
    maxLineBytes = 5 * 1024 * 1024
  } = options;

  if (signal?.aborted) {
    throw new MindchestraError('CANCELLED', 'CLI execution cancelled before start');
  }

  // Filter and sanitize environment variables
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...(env ?? {})
  };

  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd,
      env: safeEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    throw new MindchestraError(
      'UNAVAILABLE',
      `Failed to spawn executable "${executable}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const killChild = (sig: NodeJS.Signals = 'SIGTERM') => {
    try {
      if (!child.killed) {
        child.kill(sig);
      }
    } catch {
      // ignore kill errors
    }
  };

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killChild('SIGTERM');
      setTimeout(() => killChild('SIGKILL'), 1000).unref();
    }, timeoutMs);
  }

  const abortListener = () => {
    killChild('SIGTERM');
    setTimeout(() => killChild('SIGKILL'), 500).unref();
  };

  if (signal) {
    signal.addEventListener('abort', abortListener, { once: true });
  }

  const decoder = new StringDecoder('utf8');
  let lineBuffer = '';
  const linesQueue: string[] = [];
  let streamEnded = false;
  let streamError: Error | null = null;
  let stderrBuffer = '';

  let notifyNext: (() => void) | null = null;
  const triggerNext = () => {
    if (notifyNext) {
      const fn = notifyNext;
      notifyNext = null;
      fn();
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    lineBuffer += text;
    if (Buffer.byteLength(lineBuffer, 'utf8') > maxLineBytes) {
      streamError = new MindchestraError(
        'INVALID_INPUT',
        `CLI output line exceeded maximum size limit of ${maxLineBytes} bytes`
      );
      killChild('SIGKILL');
      triggerNext();
      return;
    }

    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex).trimEnd();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      linesQueue.push(line);
      newlineIndex = lineBuffer.indexOf('\n');
    }
    triggerNext();
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBuffer.length < 64 * 1024) {
      stderrBuffer += chunk.toString('utf8');
    }
  });

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const exitPromise = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      resolve({ code, sig });
    });
    child.once('error', (err) => {
      streamError = streamError ?? err;
      resolve({ code: null, sig: null });
    });
  });

  child.stdout?.once('end', () => {
    const remaining = lineBuffer + decoder.end();
    if (remaining.trim().length > 0) {
      linesQueue.push(remaining.trimEnd());
    }
    lineBuffer = '';
    streamEnded = true;
    triggerNext();
  });

  try {
    while (true) {
      while (linesQueue.length > 0) {
        const line = linesQueue.shift()!;
        if (line.length > 0) {
          yield line;
        }
      }

      if (streamError) {
        throw streamError;
      }

      if (streamEnded) {
        break;
      }

      await new Promise<void>((resolve) => {
        notifyNext = resolve;
      });
    }

    await exitPromise;

    if (timedOut) {
      throw new MindchestraError('TIMEOUT', `CLI execution timed out after ${timeoutMs}ms`);
    }

    if (signal?.aborted) {
      throw new MindchestraError('CANCELLED', 'CLI execution cancelled by abort signal');
    }

    return {
      exitCode,
      signal: exitSignal,
      stderr: redactSensitiveText(stderrBuffer)
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal) {
      signal.removeEventListener('abort', abortListener);
    }
    killChild('SIGTERM');
  }
}
