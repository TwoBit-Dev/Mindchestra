import type { AgentConfig, MCPServerConfig } from '@mindchestra/contracts';

const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /([?&](?:token|access_token|api_key|apikey|key|secret|password|auth)=)[^&\s]+/gi
];

const SENSITIVE_KEY_PATTERN = /(secret|token|password|api_?key|authorization|credential|private_?key)/i;

export function redactText(input: string, extraSecrets: readonly string[] = []): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) => {
      if (typeof prefix === 'string' && prefix.length > 0 && (prefix.startsWith('?') || prefix.startsWith('&'))) {
        return `${prefix}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  for (const secret of extraSecrets) {
    if (secret.length >= 4) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  return output;
}

export function redactValue(value: unknown, extraSecrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    return redactText(value, extraSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, extraSecrets));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof entry === 'string' && !key.endsWith('Ref') && !key.endsWith('Refs')) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactValue(entry, extraSecrets);
      }
    }
    return out;
  }
  return value;
}

function stripUrlCredentials(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      parsed.searchParams.set(key, 'REDACTED');
    }
  }
  return parsed.toString();
}

export function sanitizeMcpServerConfig(config: MCPServerConfig): MCPServerConfig {
  if (config.transport.kind === 'stdio') {
    return {
      ...config,
      transport: {
        ...config.transport,
        args: config.transport.args.map((arg) => redactText(arg))
      }
    };
  }
  return {
    ...config,
    transport: {
      ...config.transport,
      url: stripUrlCredentials(config.transport.url)
    }
  };
}

export function sanitizeAgentConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    ...(config.endpoint ? { endpoint: stripUrlCredentials(config.endpoint) } : {})
  };
}
