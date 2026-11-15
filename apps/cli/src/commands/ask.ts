import type { MissionSpec, Mode } from '@mindchestra/contracts';
import { DaemonClient } from '../client.js';

export interface AskOptions {
  mode?: string;
  agents?: string;
  workspace?: string;
  maxSeconds?: number;
  json?: boolean;
}

export async function runAsk(objective: string, options: AskOptions): Promise<number> {
  if (!objective || !objective.trim()) {
    console.error('Error: Mission objective is required (e.g. mindchestra ask "Audit memory leaks")');
    return 1;
  }

  const mode = (options.mode ?? 'council') as Mode;
  const agentList = options.agents
    ? options.agents.split(',').map((s) => s.trim())
    : ['codex', 'claude', 'antigravity'];

  const spec: MissionSpec = {
    schemaVersion: 1,
    objective: objective.trim(),
    mode,
    agents: agentList,
    workspace: options.workspace ?? 'demo-repo',
    profile: 'read-only',
    budget: {
      maxRuns: 7,
      maxSeconds: options.maxSeconds ?? 600,
      maxRounds: 2,
      maxConcurrency: 3,
      maxToolCalls: 20
    }
  };

  const client = new DaemonClient();
  try {
    const snapshot = await client.createMission(spec);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log(`\nMission Accepted! [${snapshot.id}]`);
      console.log(` Status:    ${snapshot.status}`);
      console.log(` Phase:     ${snapshot.phase}`);
      console.log(` Mode:      ${snapshot.spec.mode}`);
      console.log(` Agents:    ${snapshot.spec.agents.join(', ')}`);
      console.log(` Objective: ${snapshot.spec.objective}`);
      console.log(`\nTrack status with: mindchestra status ${snapshot.id}\n`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed to dispatch mission: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
