import { connect } from "../../packages/client/src/index.ts";
const {
  SPACETIME_URI: uri,
  SPACETIME_DB: dbName,
  SPACETIME_ADMIN_TOKEN: token,
} = process.env;
if (!uri || !dbName || !token || !/(?:^|-)exp(?:-|$)/.test(dbName))
  throw new Error(
    "Configure the isolated experiment database/admin identity first.",
  );
const session = await connect({ uri, dbName, token });
try {
  const enabled = process.env.DIBS_ENABLE_PROJECTS === "true";
  await session.conn.reducers.configureProjects({
    enabled,
    maxActiveRooms: 10,
    maxRoomsPerDay: 20,
    maxLeasesPerDay: 100,
  });
  console.log(
    `Experiment onboarding ${enabled ? "enabled" : "disabled"}: ten active rooms, twenty creations/day, one hundred analysis leases/day; thirty leases/room.`,
  );
} finally {
  session.conn.disconnect();
}
