import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { createApp } from "../../src/server.js";
import { events, store } from "../../src/data.js";

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

beforeEach(() => {
  store.sessions.clear();
  store.registrations.length = 0;
});

async function login(email = "alice@example.com", password = "alice-pass") {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, "The auth route must accept seeded users");
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    return { Cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; ") };
  }
  const body = await response.json();
  assert.equal(typeof body.token, "string", "Login must provide a session");
  return { Authorization: `Bearer ${body.token}` };
}

function register(headers = {}, eventId = "evt-1", body) {
  return fetch(
    `${baseUrl}/api/events/${encodeURIComponent(eventId)}/registrations`,
    {
      method: "POST",
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

test("registers the logged-in user without a request body", async () => {
  const response = await register(await login());
  assert.equal(response.status, 201);
  const registration = await response.json();
  assert.deepEqual(Object.keys(registration).sort(), ["eventId", "id", "userId"]);
  assert.equal(typeof registration.id, "string");
  assert.ok(registration.id.length > 0);
  assert.equal(registration.eventId, "evt-1");
  assert.equal(registration.userId, "u1");
  assert.deepEqual(store.registrations, [registration]);
});

test("rejects repeat registration without creating another record", async () => {
  const headers = await login();
  const first = await register(headers);
  assert.equal(first.status, 201);
  const original = await first.json();

  const repeated = await register(headers);
  assert.equal(repeated.status, 409);
  assert.deepEqual(await repeated.json(), { error: "Already registered" });
  assert.deepEqual(store.registrations, [original]);
});

test("allows different users to register for the same event", async () => {
  const alice = await register(await login());
  const bob = await register(await login("bob@example.com", "bob-pass"));
  assert.equal(alice.status, 201);
  assert.equal(bob.status, 201);
  const aliceRegistration = await alice.json();
  const bobRegistration = await bob.json();
  assert.equal(aliceRegistration.userId, "u1");
  assert.equal(bobRegistration.userId, "u2");
  assert.notEqual(aliceRegistration.id, bobRegistration.id);
  assert.equal(store.registrations.length, 2);
});

test("ignores client-supplied identity and registration fields", async () => {
  const headers = await login();
  const response = await register(headers, "evt-1", {
    id: "client-id",
    userId: "u2",
    eventId: "missing",
  });
  assert.equal(response.status, 201);
  const registration = await response.json();
  assert.equal(registration.userId, "u1");
  assert.equal(registration.eventId, "evt-1");
  assert.notEqual(registration.id, "client-id");
  assert.equal((await register(headers, "evt-1", { userId: "u2" })).status, 409);
});

test("rejects unauthenticated requests even with a supplied userId", async () => {
  const response = await register({}, "evt-1", { userId: "u1" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.deepEqual(store.registrations, []);
});

test("rejects a session that has been invalidated", async () => {
  const headers = await login();
  store.sessions.clear();
  const response = await register(headers);
  assert.equal(response.status, 401);
  assert.deepEqual(store.registrations, []);
});

test("returns 404 for an unknown event without storing a registration", async () => {
  const response = await register(await login(), "missing");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Event not found" });
  assert.deepEqual(store.registrations, []);
});

test("authenticates before checking whether an event exists", async () => {
  const response = await register({}, "missing");
  assert.equal(response.status, 401);
  assert.deepEqual(store.registrations, []);
});

test("allows the same user to register for different events", async (t) => {
  const otherEvent = { id: "evt-test-2", title: "Another test event" };
  events.push(otherEvent);
  t.after(() => events.splice(events.indexOf(otherEvent), 1));

  const headers = await login();
  const first = await register(headers);
  const second = await register(headers, otherEvent.id);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await second.json()).eventId, otherEvent.id);
  assert.equal(store.registrations.length, 2);
});

test("concurrent requests create only one registration", async () => {
  const headers = await login();
  const responses = await Promise.all([register(headers), register(headers)]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  );
  assert.equal(store.registrations.length, 1);
});
