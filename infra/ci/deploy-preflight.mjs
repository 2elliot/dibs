// Validate names and credential presence without ever printing credential values.
import assert from "node:assert/strict";
const required = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "SPACETIME_PUBLISH_TOKEN",
  "SPACETIME_ADMIN_TOKEN",
  "SPACETIME_WORKER_TOKEN",
  "ANTHROPIC_API_KEY",
  "SPACETIME_URI",
  "SPACETIME_DB",
  "AZURE_RESOURCE_GROUP",
  "AZURE_CONTAINER_APP",
  "AZURE_ACR_NAME",
];
const missing = required.filter((name) => !process.env[name]?.trim());
assert.equal(
  missing.length,
  0,
  `Configure the real-exp GitHub environment before deployment. Missing names: ${missing.join(", ")}`,
);
assert.ok(
  /(?:^|-)exp(?:-|$)/.test(process.env.SPACETIME_DB),
  "Deployment only targets a separately named -exp database.",
);
assert.ok(
  /(?:^|-)exp(?:-|$)/.test(process.env.AZURE_CONTAINER_APP),
  "Deployment only targets a separately named -exp Azure app.",
);
assert.equal(
  new URL(process.env.SPACETIME_URI).protocol,
  "https:",
  "The deployment database requires HTTPS.",
);
for (const name of [
  "SPACETIME_DB",
  "AZURE_RESOURCE_GROUP",
  "AZURE_CONTAINER_APP",
  "AZURE_ACR_NAME",
])
  assert.match(
    process.env[name],
    /^[a-zA-Z0-9][a-zA-Z0-9-]*$/,
    `${name} contains unsupported characters.`,
  );
console.log(
  "Experiment deployment configuration is present and targets isolated resources.",
);
