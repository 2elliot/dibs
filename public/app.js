// The session token stays in memory and is sent only in Authorization headers.
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
      status.textContent = 'Invalid email or password';
      return;
    }
    if (response.status !== 200) throw new Error('Login failed');
    const session = await response.json();
    if (typeof session.token !== 'string' || !session.token) throw new Error('Missing token');
    token = session.token;
    status.textContent = 'Logged in';
  } catch {
    status.textContent = 'Unable to log in. Please try again.';
  } finally {
    setBusy(false);
  }
});

registerButton.addEventListener('click', async () => {
  if (busy) return;
  if (!token) {
    status.textContent = 'Please log in';
    return;
  }
  setBusy(true);
  status.textContent = 'Registering…';
  try {
    const response = await fetch(`/api/events/${encodeURIComponent(registerButton.dataset.eventId)}/registrations`, {
      method: 'POST',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 201) status.textContent = 'Registered';
    else if (response.status === 409) status.textContent = 'Already registered';
    else if (response.status === 401) {
      token = null;
      status.textContent = 'Please log in';
    } else if (response.status === 404) status.textContent = 'Event not found';
    else status.textContent = 'Unable to register. Please try again.';
  } catch {
    status.textContent = 'Unable to register. Please try again.';
  } finally {
    setBusy(false);
  }
});
