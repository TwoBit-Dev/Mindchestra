import { describe, expect, it, vi } from 'vitest';
import { main } from '@mindchestra/cli';

describe('Mindchestra CLI', () => {
  it('handles --version flag', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg)));

    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('mindchestra v0.1.0'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('handles --help flag', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg)));

    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('Usage:'))).toBe(true);
    expect(logs.some((l) => l.includes('doctor'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('runs doctor with --json flag and outputs structured checks', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg)));

    const code = await main(['doctor', '--json']);
    expect(code).toBe(0);
    expect(logs.length).toBeGreaterThan(0);

    const jsonStr = logs[0]!;
    const parsed = JSON.parse(jsonStr);
    expect(parsed).toHaveProperty('checks');
    expect(Array.isArray(parsed.checks)).toBe(true);

    vi.restoreAllMocks();
  });

  it('runs init --preview --json without creating files', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg)));

    const code = await main(['init', '--preview', '--json']);
    expect(code).toBe(0);

    const jsonStr = logs[0]!;
    const parsed = JSON.parse(jsonStr);
    expect(parsed.action).toBe('preview');
    expect(parsed.config.defaultMode).toBe('council');

    vi.restoreAllMocks();
  });

  it('returns exit code 1 for unknown commands', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => errors.push(String(msg)));

    const code = await main(['nonexistent-command']);
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes('Unknown command'))).toBe(true);

    vi.restoreAllMocks();
  });
});
