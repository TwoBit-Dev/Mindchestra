import { execSync } from 'node:child_process';
import { DaemonClient } from '../client.js';

export interface DoctorCheck {
  name: string;
  category: 'runtime' | 'daemon' | 'providers';
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

function checkExecutable(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(options: { json?: boolean }): Promise<number> {
  const checks: DoctorCheck[] = [];

  // 1. Node runtime
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  if (major >= 22) {
    checks.push({
      name: 'Node.js Version',
      category: 'runtime',
      status: 'ok',
      detail: `${nodeVersion} (>=22.0.0 required)`
    });
  } else {
    checks.push({
      name: 'Node.js Version',
      category: 'runtime',
      status: 'fail',
      detail: `${nodeVersion} (>=22.0.0 required)`
    });
  }

  // 2. pnpm
  const hasPnpm = checkExecutable('pnpm');
  checks.push({
    name: 'pnpm Package Manager',
    category: 'runtime',
    status: hasPnpm ? 'ok' : 'fail',
    detail: hasPnpm ? 'Detected on PATH' : 'pnpm not found on PATH'
  });

  // 3. Daemon Health
  const client = new DaemonClient();
  try {
    const health = await client.health();
    checks.push({
      name: 'Mindchestra Daemon',
      category: 'daemon',
      status: 'ok',
      detail: `Online (v${health.version}, status: ${health.status})`
    });
  } catch (err) {
    checks.push({
      name: 'Mindchestra Daemon',
      category: 'daemon',
      status: 'warn',
      detail: 'Offline (run "pnpm --filter @mindchestra/daemon dev" to start)'
    });
  }

  // 4. Provider CLI checks
  for (const [bin, name] of [
    ['codex', 'Codex CLI'],
    ['claude', 'Claude Code CLI'],
    ['agy', 'Antigravity CLI']
  ] as const) {
    const installed = checkExecutable(bin);
    checks.push({
      name,
      category: 'providers',
      status: installed ? 'ok' : 'warn',
      detail: installed ? `Found executable "${bin}" on PATH` : `"${bin}" not found on PATH (optional for mock)`
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ checks, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log('\nMindchestra Doctor Diagnostics:\n');
    for (const check of checks) {
      const symbol = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗';
      const color =
        check.status === 'ok' ? '\x1b[32m' : check.status === 'warn' ? '\x1b[33m' : '\x1b[31m';
      console.log(` ${color}${symbol}\x1b[0m [${check.category}] ${check.name.padEnd(26)} : ${check.detail}`);
    }
    console.log('');
  }

  const hasFails = checks.some((c) => c.status === 'fail');
  return hasFails ? 1 : 0;
}
