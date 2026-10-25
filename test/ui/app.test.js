import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');

function harness(responses) {
  const elements = Object.fromEntries([
    'login-form', 'login-button', 'register-button', 'email', 'password', 'status',
  ].map(id => [id, {
    value: '', textContent: '', disabled: false, dataset: {}, listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
  }]));
  elements.email.value = 'alice@example.com';
  elements.password.value = 'alice-pass';
  elements['register-button'].dataset.eventId = 'evt-1';
  const requests = [];
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, `Unexpected request: ${url}`);
      return { ok: response.status >= 200 && response.status < 300,
        status: response.status, json: async () => response.body };
    },
  });
  return { elements, requests,
    login: () => elements['login-form'].listeners.submit({ preventDefault() {} }),
    register: () => elements['register-button'].listeners.click(),
  };
}

const loginResponses = () => [
  { status: 200, body: { token: 'alice-session' } },
  { status: 200, body: { id: 'u1', email: 'alice@example.com' } },
];

test('login, current user and registration share only the bearer session', async () => {
  const ui = harness([...loginResponses(), { status: 201 }, { status: 409 }]);
  await ui.login();
  assert.equal(ui.elements.status.textContent, 'Logged in as alice@example.com');
  assert.equal(ui.elements.password.value, '');
  assert.deepEqual(JSON.parse(ui.requests[0].body), {
    email: 'alice@example.com', password: 'alice-pass',
  });
  assert.equal(ui.requests[0].headers['Content-Type'], 'application/json');
  assert.equal(ui.requests[1].url, '/api/me');
  ui.elements['register-button'].dataset.eventId = 'event / 2';
  await ui.register();
  assert.equal(ui.elements.status.textContent, 'Registered');
  assert.equal(ui.requests[2].url, '/api/events/event%20%2F%202/registrations');
  assert.equal(ui.requests[2].method, 'POST');
  assert.equal(ui.requests[2].body, undefined);
  for (const request of ui.requests.slice(1)) {
    assert.equal(request.headers.Authorization, 'Bearer alice-session');
    assert.equal(request.credentials, 'omit');
  }
  await ui.register();
  assert.equal(ui.elements.status.textContent, 'Already registered');
});

test('registration before login prompts without sending a request', async () => {
  const ui = harness([]);
  await ui.register();
  assert.match(ui.elements.status.textContent, /Please log in/);
  assert.equal(ui.requests.length, 0);
});

test('failed re-login discards the previous session', async () => {
  const ui = harness([...loginResponses(), { status: 401 }]);
  await ui.login();
  await ui.login();
  assert.match(ui.elements.status.textContent, /Invalid email or password/);
  await ui.register();
  assert.match(ui.elements.status.textContent, /Please log in/);
  assert.equal(ui.requests.length, 3);
});

test('expired current-user session requires login', async () => {
  const ui = harness([{ status: 200, body: { token: 'expired' } }, { status: 401 }]);
  await ui.login();
  await ui.register();
  assert.match(ui.elements.status.textContent, /Please log in/);
  assert.equal(ui.requests.length, 2);
});

for (const [response, message] of [
  [{ status: 401 }, 'Please log in to register.'],
  [{ status: 404 }, 'Event not found'],
  [{ status: 500 }, 'Unable to register. Please try again.'],
  [new Error('offline'), 'Unable to register. Please try again.'],
]) {
  test(`registration handles ${response.status ?? 'network failure'}`, async () => {
    const ui = harness([...loginResponses(), response]);
    await ui.login();
    await ui.register();
    assert.equal(ui.elements.status.textContent, message);
    assert.equal(ui.elements['register-button'].disabled, false);
    assert.equal(ui.elements['login-button'].disabled, false);
    if (response.status === 401) {
      await ui.register();
      assert.equal(ui.requests.length, 3);
    }
  });
}

test('network login failure restores controls and allows retry', async () => {
  const ui = harness([new Error('offline'), ...loginResponses()]);
  const pending = ui.login();
  assert.equal(ui.elements['login-button'].disabled, true);
  await ui.login(); // Ignore a second submit while the first is pending.
  await pending;
  assert.equal(ui.requests.length, 1);
  assert.match(ui.elements.status.textContent, /Unable to log in/);
  assert.equal(ui.elements['login-button'].disabled, false);
  await ui.login();
  assert.equal(ui.elements.status.textContent, 'Logged in as alice@example.com');
});
