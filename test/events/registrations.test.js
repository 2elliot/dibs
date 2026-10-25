import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { events, store, users } from "../../src/data.js";

// Stub only the external auth boundary so these tests also run in this area's
// isolated checkout, before the auth developer's implementation is collected.
const routeUrl = new URL("../../src/events/routes.js", import.meta.url).href;
const authUrl = new URL("../../src/auth/index.js", import.meta.url).href;
const authStubUrl = `data:text/javascript,${encodeURIComponent(
  "export const getCurrentUser = (req) => req.currentUser ?? null;",
)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL === routeUrl &&
      new URL(specifier, context.parentURL).href === authUrl
    ) {
      return { url: authStubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let eventRoutes;
try {
  ({ default: eventRoutes } = await import(routeUrl));
} finally {
  hooks.deregister();
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = users.find((entry) => entry.id === req.get("x-test-user"));
    req.currentUser = user ? { id: user.id, email: user.email } : null;
    next();
  });
  app.use(eventRoutes);
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  store.registrations.length = 0;
});

after(async () => {
  store.registrations.length = 0;
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function register({
  userId = "u1",
  eventId = "evt-1",
  body,
  headers = {},
} = {}) {
  const response = await fetch(
    `${baseUrl}/api/events/${encodeURIComponent(eventId)}/registrations`,
    {
      method: "POST",
      headers: {
        ...(userId ? { "x-test-user": userId } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, body: await response.json() };
}

test("creates a registration for the current user without a request body", async () => {
  const result = await register();

  assert.equal(result.status, 201);
  assert.equal(typeof result.body.id, "string");
  assert.ok(result.body.id.length > 0);
  assert.deepEqual(result.body, {
    id: result.body.id,
    eventId: "evt-1",
    userId: "u1",
  });
  assert.deepEqual(store.registrations, [result.body]);
});

test("uses the authenticated user and path event, not supplied registration fields", async () => {
  const result = await register({
    body: { id: "forged", userId: "u2", eventId: "missing" },
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.userId, "u1");
  assert.equal(result.body.eventId, "evt-1");
  assert.notEqual(result.body.id, "forged");
  assert.deepEqual(store.registrations, [result.body]);
});

test("returns 409 for the same user and event without changing the registration", async () => {
  const first = await register();
  const repeated = await register({ body: { userId: "u2" } });

  assert.equal(first.status, 201);
  assert.deepEqual(repeated, {
    status: 409,
    body: { error: "Already registered" },
  });
  assert.deepEqual(store.registrations, [first.body]);
});

test("allows different users to register for the same event", async () => {
  const alice = await register();
  const bob = await register({ userId: "u2", body: {} });

  assert.equal(alice.status, 201);
  assert.equal(bob.status, 201);
  assert.equal(alice.body.userId, "u1");
  assert.equal(bob.body.userId, "u2");
  assert.notEqual(alice.body.id, bob.body.id);
  assert.deepEqual(store.registrations, [alice.body, bob.body]);
});

test("allows the same user to register for different events", async () => {
  const event = { id: "evt-registration-test", title: "Another event" };
  events.push(event);
  try {
    const first = await register();
    const second = await register({ eventId: event.id });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.eventId, event.id);
    assert.equal(second.body.userId, "u1");
    assert.notEqual(first.body.id, second.body.id);
    assert.deepEqual(store.registrations, [first.body, second.body]);
  } finally {
    events.splice(events.indexOf(event), 1);
  }
});

test("returns 401 when the current-user helper returns no user", async () => {
  const result = await register({
    userId: null,
    body: { userId: "u1" },
    headers: { Authorization: "Bearer invalid" },
  });

  assert.deepEqual(result, {
    status: 401,
    body: { error: "Unauthorized" },
  });
  assert.deepEqual(store.registrations, []);
});

test("checks authentication before looking up an unknown event", async () => {
  const result = await register({ userId: null, eventId: "missing" });

  assert.deepEqual(result, {
    status: 401,
    body: { error: "Unauthorized" },
  });
  assert.deepEqual(store.registrations, []);
});

test("returns 404 for an authenticated request for an unknown event", async () => {
  const result = await register({ eventId: "missing" });

  assert.deepEqual(result, {
    status: 404,
    body: { error: "Event not found" },
  });
  assert.deepEqual(store.registrations, []);
});

test("creates only one registration for simultaneous requests by the same user", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => register()),
  );

  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 7);
  assert.equal(store.registrations.length, 1);
  assert.deepEqual(
    store.registrations[0],
    results.find((result) => result.status === 201).body,
  );
});
