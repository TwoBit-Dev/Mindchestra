import { spawn } from 'node:child_process';

export async function runDashboard(options: { port?: number; open?: boolean }): Promise<number> {
  const port = options.port ?? 5173;
  const url = `http://127.0.0.1:${port}`;

  console.log(`\nMindchestra Dashboard available at: \x1b[36m${url}\x1b[0m`);
  console.log('To start dev server: pnpm --filter @mindchestra/web dev\n');

  if (options.open) {
    try {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(openCmd, [url], { stdio: 'ignore', detached: true }).unref();
    } catch {
      // ignore open failure
    }
  }

  return 0;
}
