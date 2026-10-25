const endpoint = process.env.DIBS_DEPLOY_URL;
if (!endpoint) throw new Error("Deployed endpoint is missing.");
const deadline = Date.now() + 180000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const read = async (route) => {
      const response = await fetch(endpoint + route, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Revision unavailable");
      return response.json();
    };
    const [config, health] = await Promise.all([
      read("/config.json"),
      read("/health/status"),
    ]);
    if (
      config.buildSha === process.env.GITHUB_SHA &&
      config.projectProtocol === "project-v1" &&
      config.dbName === process.env.SPACETIME_DB &&
      config.dbUri === process.env.SPACETIME_URI &&
      health.db === "connected"
    ) {
      ready = true;
      break;
    }
  } catch {
    /* wait for startup/traffic transition */
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!ready)
  throw new Error(
    "The new worker revision is not ready; project onboarding remains disabled.",
  );
console.log(
  "The tested worker revision is serving the configured experiment database.",
);
