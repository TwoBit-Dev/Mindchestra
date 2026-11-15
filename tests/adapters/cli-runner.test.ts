import { describe, expect, it } from 'vitest';
import { redactSensitiveText, streamCliLines } from '@mindchestra/adapter-sdk';

describe('CliRunner and Redaction', () => {
  it('redacts tokens and api keys from text', () => {
    const raw = 'Error with token=sk-abcdef123456789012345678 and Bearer eyJhbGciOiJIUzI1NiJ9';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain('sk-abcdef123456789012345678');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted).toContain('[REDACTED]');
  });

  it('safely runs system echo with shell: false and streams lines', async () => {
    const lines: string[] = [];
    const runner = streamCliLines({
      executable: 'echo',
      args: ['hello world\nline two']
    });

    for await (const line of runner) {
      lines.push(line);
    }

    expect(lines).toContain('hello world');
    expect(lines).toContain('line two');
  });

  it('handles abort signal cancellation during CLI run', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(async () => {
      const runner = streamCliLines({
        executable: 'echo',
        args: ['fast'],
        signal: controller.signal
      });
      for await (const _line of runner) {
        // should not reach
      }
    }).rejects.toThrow(/cancelled/i);
  });
});
