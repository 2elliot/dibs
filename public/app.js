const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const registerButton = document.querySelector("#register-button");
const status = document.querySelector("#status");

// Keep login and registration ordered so Register uses the completed login.
let pending = false;
async function performRequest(message, action) {
  if (pending) return;
  pending = true;
  loginButton.disabled = true;
  registerButton.disabled = true;
  status.textContent = message;
  try {
    await action();
  } catch {
    status.textContent = "Unable to connect. Please try again.";
  } finally {
    pending = false;
    loginButton.disabled = false;
    registerButton.disabled = false;
  }
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  return performRequest("Logging in…", async () => {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: loginForm.elements.email.value,
        password: loginForm.elements.password.value,
      }),
    });
    if (response.status === 200) {
      status.textContent = "Logged in";
      loginForm.elements.password.value = "";
    } else {
      status.textContent = response.status === 401
        ? "Invalid email or password."
        : "Unable to log in. Please try again.";
    }
  });
});

registerButton.addEventListener("click", () =>
  performRequest("Registering…", async () => {
    const eventId = encodeURIComponent(registerButton.dataset.eventId);
    const response = await fetch(`/api/events/${eventId}/registrations`, {
      method: "POST",
      credentials: "same-origin",
    });
    status.textContent = {
      201: "Registered",
      409: "Already registered",
      401: "Please log in to register.",
      404: "Event not found.",
    }[response.status] ?? "Unable to register. Please try again.";
  }),
);
