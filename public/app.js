// The session token lives only for this page's lifetime.
const loginForm = document.getElementById('login-form');
const loginButton = document.getElementById('login-button');
const registerButton = document.getElementById('register-button');
const status = document.getElementById('status');
let token = null;
let busy = false;

function setBusy(value) {
  busy = value;
  loginButton.disabled = value;
  registerButton.disabled = value;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  token = null;
  status.textContent = 'Logging in…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    if (response.status === 401) {
      status.textContent = 'Invalid email or password. Please log in again.';
      return;
    }
    if (!response.ok) throw new Error('Login failed');
    const session = await response.json();
    if (typeof session.token !== 'string' || !session.token) {
      throw new Error('Missing session token');
    }
    token = session.token;
    const me = await fetch('/api/me', {
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (me.status === 401) {
      token = null;
      status.textContent = 'Please log in again.';
      return;
    }
    if (!me.ok) throw new Error('Could not verify login');
    const user = await me.json();
    status.textContent = `Logged in as ${user.email}`;
    document.getElementById('password').value = '';
  } catch {
    token = null;
    status.textContent = 'Unable to log in. Please try again.';
  } finally {
    setBusy(false);
  }
});

registerButton.addEventListener('click', async () => {
  if (busy) return;
  if (!token) {
    status.textContent = 'Please log in to register.';
    return;
  }
  setBusy(true);
  status.textContent = 'Registering…';
  try {
    const eventId = encodeURIComponent(registerButton.dataset.eventId);
    const response = await fetch(`/api/events/${eventId}/registrations`, {
      method: 'POST',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    });
    switch (response.status) {
      case 201: status.textContent = 'Registered'; break;
      case 409: status.textContent = 'Already registered'; break;
      case 401:
        token = null;
        status.textContent = 'Please log in to register.';
        break;
      case 404: status.textContent = 'Event not found'; break;
      default: status.textContent = 'Unable to register. Please try again.';
    }
  } catch {
    status.textContent = 'Unable to register. Please try again.';
  } finally {
    setBusy(false);
  }
});
