import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runInit(options: { cwd?: string; preview?: boolean; json?: boolean }): Promise<number> {
  const targetDir = options.cwd ?? process.cwd();
  const configPath = path.join(targetDir, '.mindchestra.json');

  const defaultConfig = {
    schemaVersion: 1,
    defaultMode: 'council',
    defaultProfile: 'read-only',
    agents: ['codex', 'claude', 'antigravity'],
    daemonUrl: 'http://127.0.0.1:4311',
    storagePath: './.mindchestra'
  };

  if (options.preview) {
    if (options.json) {
      console.log(JSON.stringify({ target: configPath, action: 'preview', config: defaultConfig }, null, 2));
    } else {
      console.log(`\n[Preview] Would create configuration at: ${configPath}`);
      console.log(JSON.stringify(defaultConfig, null, 2));
      console.log('\n(Run without --preview to apply changes)\n');
    }
    return 0;
  }

  if (existsSync(configPath)) {
    console.log(`Configuration already exists at ${configPath}. Existing settings preserved.`);
    return 0;
  }

  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
  console.log(`\nInitialized Mindchestra workspace configuration at: ${configPath}\n`);
  return 0;
}
