import { parseArgs } from 'node:util';
import { runDoctor } from './commands/doctor.js';
import { runAgents } from './commands/agents.js';
import { runAsk } from './commands/ask.js';
import { runStatus } from './commands/status.js';
import { runCancel } from './commands/cancel.js';
import { runInit } from './commands/init.js';
import { runDashboard } from './commands/dashboard.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      preview: { type: 'boolean' },
      mode: { type: 'string', short: 'm' },
      agents: { type: 'string', short: 'a' },
      workspace: { type: 'string', short: 'w' }
    },
    allowPositionals: true,
    strict: false
  });

  if (values.version) {
    console.log('mindchestra v0.1.0 (TwoBit Dev)');
    return 0;
  }

  const command = positionals[0];

  if (values.help || !command) {
    console.log(`
mindchestra. — Many minds. One conductor.

Usage:
  mindchestra <command> [options]

Commands:
  doctor              Diagnose runtime, dependencies, daemon & provider CLI status
  init                Initialize local workspace configuration (.mindchestra.json)
  agents <subcommand> Manage agents (list, probe <agentId>)
  ask "<objective>"   Dispatch a new multi-agent mission
  status <missionId>  Check snapshot & progress of a mission
  cancel <missionId>  Cancel a running mission
  dashboard           Print or launch the React + Vite dashboard

Global Options:
  -h, --help          Show help
  -v, --version       Show version
  --json              Format output as structured JSON
  --preview           Preview changes without applying (for init)
`);
    return 0;
  }

  const isJson = Boolean(values.json);
  const isPreview = Boolean(values.preview);
  const modeStr = typeof values.mode === 'string' ? values.mode : undefined;
  const agentsStr = typeof values.agents === 'string' ? values.agents : undefined;
  const workspaceStr = typeof values.workspace === 'string' ? values.workspace : undefined;

  switch (command) {
    case 'doctor':
      return await runDoctor({ json: isJson });

    case 'init':
      return await runInit({ preview: isPreview, json: isJson });

    case 'agents':
      return await runAgents(positionals[1] ?? 'list', positionals.slice(2), { json: isJson });

    case 'ask':
      return await runAsk(positionals[1] ?? '', {
        mode: modeStr,
        agents: agentsStr,
        workspace: workspaceStr,
        json: isJson
      });

    case 'status':
      return await runStatus(positionals[1] ?? '', { json: isJson });

    case 'cancel':
      return await runCancel(positionals[1] ?? '', { json: isJson });

    case 'dashboard':
      return await runDashboard({});

    default:
      console.error(`Unknown command: "${command}". Run "mindchestra --help" for available commands.`);
      return 1;
  }
}

// If invoked as a CLI script directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mindchestra.js')) {
  main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
