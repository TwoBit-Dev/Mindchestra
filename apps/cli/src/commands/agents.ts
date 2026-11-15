import { DaemonClient } from '../client.js';

export async function runAgents(
  subcommand: string,
  args: string[],
  options: { json?: boolean }
): Promise<number> {
  const client = new DaemonClient();

  if (subcommand === 'list' || !subcommand) {
    try {
      const { items } = await client.listAgents();
      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log('\nRegistered Mindchestra Agents:\n');
        for (const item of items) {
          const status = item.probe?.status ?? 'unprobed';
          console.log(` • ${item.manifest.displayName.padEnd(28)} [${item.manifest.id}]`);
          console.log(`   Provider: ${item.manifest.provider} | Kind: ${item.manifest.kind} | Status: ${status}`);
        }
        console.log('');
      }
      return 0;
    } catch (err) {
      console.error(`Error listing agents: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (subcommand === 'probe') {
    const agentId = args[0];
    if (!agentId) {
      console.error('Error: agent ID required (e.g. "mindchestra agents probe codex")');
      return 1;
    }

    try {
      const probe = await client.probeAgent(agentId);
      if (options.json) {
        console.log(JSON.stringify(probe, null, 2));
      } else {
        console.log(`\nProbe Result for "${agentId}":`);
        console.log(` Status:       ${probe.status}`);
        console.log(` Checked At:   ${probe.checkedAt}`);
        if (probe.version) console.log(` Version:      ${probe.version}`);
        if (probe.detail) console.log(` Detail:       ${probe.detail}`);
        console.log(` Capabilities: ${Object.entries(probe.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}\n`);
      }
      return 0;
    } catch (err) {
      console.error(`Error probing agent "${agentId}": ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  console.error(`Unknown agents subcommand: ${subcommand}. Use "list" or "probe <id>".`);
  return 1;
}
