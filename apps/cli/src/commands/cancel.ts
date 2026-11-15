import { DaemonClient } from '../client.js';

export async function runCancel(missionId: string, options: { json?: boolean }): Promise<number> {
  if (!missionId) {
    console.error('Error: Mission ID is required (e.g. mindchestra cancel <missionId>)');
    return 1;
  }

  const client = new DaemonClient();
  try {
    const snapshot = await client.cancelMission(missionId);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log(`\nMission [${snapshot.id}] cancellation requested.`);
      console.log(` Current Status: ${snapshot.status}\n`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed to cancel mission: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
