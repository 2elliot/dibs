import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { events, store } from "../../src/data.js";
import { createApp } from "../../src/server.js";

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
  return token;
}

function register(token, { eventId = "evt-1", body, headers = {} } = {}) {
  return fetch(
    `${baseUrl}/api/events/${encodeURIComponent(eventId)}/registrations`,
    {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

test("registers the logged-in user without a request body", async () => {
  const token = await login();
  const me = await fetch(`${baseUrl}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  const user = await me.json();

  const response = await register(token);
  assert.equal(response.status, 201);
  const registration = await response.json();
  assert.equal(typeof registration.id, "string");
  assert.ok(registration.id.length > 0);
  assert.deepEqual(registration, {
    id: registration.id,
    eventId: "evt-1",
    userId: user.id,
  });
  assert.deepEqual(store.registrations, [registration]);
});

test("uses the authenticated user and URL event, not client-supplied fields", async () => {
  const token = await login();
  const response = await register(token, {
    body: { id: "client-id", eventId: "missing-event", userId: "u2" },
  });
  assert.equal(response.status, 201);
  const registration = await response.json();
  assert.equal(registration.userId, "u1");
  assert.equal(registration.eventId, "evt-1");
  assert.notEqual(registration.id, "client-id");
  assert.deepEqual(store.registrations, [registration]);
});

test("rejects a duplicate without changing the original registration", async () => {
  const token = await login();
  const first = await register(token);
  assert.equal(first.status, 201);
  const original = await first.json();

  const duplicate = await register(token);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "Already registered" });
  assert.deepEqual(store.registrations, [original]);
});

test("a new session for the same user cannot register again", async () => {
  const first = await register(await login());
  assert.equal(first.status, 201);
  const second = await register(await login());
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "Already registered" });
  assert.equal(store.registrations.length, 1);
});

test("different users can register for the same event with distinct IDs", async () => {
  const alice = await register(await login());
  const bob = await register(await login("bob@example.com", "bob-pass"));
  assert.equal(alice.status, 201);
  assert.equal(bob.status, 201);
  const aliceRegistration = await alice.json();
  const bobRegistration = await bob.json();
  assert.equal(aliceRegistration.userId, "u1");
  assert.equal(bobRegistration.userId, "u2");
  assert.equal(aliceRegistration.eventId, bobRegistration.eventId);
  assert.notEqual(aliceRegistration.id, bobRegistration.id);
  assert.deepEqual(store.registrations, [aliceRegistration, bobRegistration]);
});

test("the same user can register for different events", async (context) => {
  const event = { id: "evt-2", title: "Another event" };
  events.push(event);
  context.after(() => {
    events.splice(events.indexOf(event), 1);
  });

  const token = await login();
  const first = await register(token);
  const second = await register(token, { eventId: event.id });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstRegistration = await first.json();
  const secondRegistration = await second.json();
  assert.equal(firstRegistration.userId, secondRegistration.userId);
  assert.equal(secondRegistration.eventId, event.id);
  assert.notEqual(firstRegistration.id, secondRegistration.id);
  assert.equal(store.registrations.length, 2);
});

for (const [name, token, options] of [
  ["missing session", undefined, {}],
  ["invalid token", "not-a-session", {}],
  ["malformed authorization", undefined, { headers: { Authorization: "Basic abc" } }],
  ["body-only identity", undefined, { body: { userId: "u1" } }],
]) {
  test(`rejects ${name} with 401 and no registration`, async () => {
    const response = await register(token, options);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.deepEqual(store.registrations, []);
  });
}

test("does not accept a bearer session token through a cookie", async () => {
  const token = await login();
  const response = await register(undefined, {
    headers: { Cookie: `session=${token}; token=${token}` },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.deepEqual(store.registrations, []);
});

test("returns 404 for an unknown event after authenticating", async () => {
  const response = await register(await login(), { eventId: "missing-event" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Event not found" });
  assert.deepEqual(store.registrations, []);
});

test("checks authentication before revealing an unknown event", async () => {
  const response = await register(undefined, { eventId: "missing-event" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.deepEqual(store.registrations, []);
});

test("concurrent requests create only one registration", async () => {
  const token = await login();
  const responses = await Promise.all([register(token), register(token)]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  );
  const results = await Promise.all(responses.map((response) => response.json()));
  const created = results[responses.findIndex((response) => response.status === 201)];
  assert.deepEqual(
    results[responses.findIndex((response) => response.status === 409)],
    { error: "Already registered" },
  );
  assert.deepEqual(store.registrations, [created]);
});
