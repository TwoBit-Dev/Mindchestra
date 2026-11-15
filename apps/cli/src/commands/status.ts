import { DaemonClient } from '../client.js';

export async function runStatus(missionId: string, options: { json?: boolean }): Promise<number> {
  if (!missionId) {
    console.error('Error: Mission ID is required (e.g. mindchestra status <missionId>)');
    return 1;
  }

  const client = new DaemonClient();
  try {
    const snapshot = await client.getMission(missionId);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log(`\nMission Snapshot [${snapshot.id}]:`);
      console.log(` Status:    ${snapshot.status}`);
      console.log(` Phase:     ${snapshot.phase}`);
      console.log(` Mode:      ${snapshot.spec.mode}`);
      console.log(` Created:   ${snapshot.createdAt}`);
      console.log(` Updated:   ${snapshot.updatedAt}`);
      console.log(` Last Seq:  #${snapshot.lastSeq}`);
      console.log(` Result:    ${snapshot.resultAvailable ? 'Available' : 'Pending'}\n`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
