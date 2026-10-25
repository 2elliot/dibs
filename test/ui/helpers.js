import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Minimal DOM surface used by the page; execute the actual browser script.
export async function loadPage(fetch) {
  const elements = Object.fromEntries(
    ['login-form', 'login-button', 'email', 'password', 'register-button', 'status'].map(id => [id, {
      value: '', textContent: '', disabled: false, dataset: {}, listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
    }]),
  );
  elements['register-button'].dataset.eventId = 'evt-1';
  const source = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] }, fetch, encodeURIComponent,
  });
  return {
    elements,
    async login(email = 'alice@example.com', password = 'alice-pass') {
      elements.email.value = email;
      elements.password.value = password;
      await elements['login-form'].listeners.submit({ preventDefault() {} });
    },
    async register() { await elements['register-button'].listeners.click(); },
  };
}
