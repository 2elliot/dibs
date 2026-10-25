import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers.js';

const response = (status, body) => ({ status, async json() { return body; } });

test('login sends credentials as JSON; registration uses only the returned bearer token and page event', async () => {
  const calls = [];
  const page = await loadPage(async (url, options) => {
    calls.push({ url, options });
    return url === '/api/login' ? response(200, { token: 'session-alice' }) : response(201);
  });
  await page.login();
  assert.equal(page.elements.status.textContent, 'Logged in');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'alice@example.com', password: 'alice-pass' });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  page.elements['register-button'].dataset.eventId = 'event /2';
  await page.register();
  assert.equal(calls[1].url, '/api/events/event%20%2F2/registrations');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer session-alice');
  assert.equal(calls[1].options.body, undefined);
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
  }
  assert.equal(page.elements.status.textContent, 'Registered');
});

for (const [code, message] of [[409, 'Already registered'], [401, 'Please log in'], [404, 'Event not found'], [500, 'Unable to register. Please try again.']]) {
  test(`registration handles ${code}`, async () => {
    let requests = 0;
    const page = await loadPage(async () => ++requests === 1 ? response(200, { token: 'token' }) : response(code));
    await page.login();
    await page.register();
    assert.equal(page.elements.status.textContent, message);
    assert.equal(page.elements['register-button'].disabled, false);
    if (code === 401) {
      await page.register();
      assert.equal(requests, 2, 'expired token is cleared');
    }
  });
}

test('failed re-login clears the old session and prevents registration as the previous user', async () => {
  let requests = 0;
  const page = await loadPage(async () => ++requests === 1 ? response(200, { token: 'alice' }) : response(401));
  await page.login();
  await page.login('bob@example.com', 'wrong');
  assert.equal(page.elements.status.textContent, 'Invalid email or password');
  await page.register();
  assert.equal(page.elements.status.textContent, 'Please log in');
  assert.equal(requests, 2);
});

for (const operation of ['login', 'register']) {
  test(`${operation} network failure restores controls and allows retry`, async () => {
    let fail = operation === 'login';
    const page = await loadPage(async () => {
      if (fail) throw new Error('offline');
      return response(200, { token: 'token' });
    });
    await page.login();
    if (operation === 'register') { fail = true; await page.register(); }
    assert.match(page.elements.status.textContent, /Please try again/);
    assert.equal(page.elements['login-button'].disabled, false);
    assert.equal(page.elements['register-button'].disabled, false);
    fail = false;
    await page.login();
    assert.equal(page.elements.status.textContent, 'Logged in');
  });
}

test('prevents overlapping login and registration requests', async () => {
  let resolve;
  let requests = 0;
  const page = await loadPage(() => {
    requests++;
    return new Promise(done => { resolve = done; });
  });
  const pending = page.login();
  assert.equal(page.elements['login-button'].disabled, true);
  await page.register();
  await page.login();
  assert.equal(requests, 1);
  resolve(response(200, { token: 'token' }));
  await pending;
  assert.equal(page.elements['login-button'].disabled, false);
});
