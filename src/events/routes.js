// Event registration. Mounted by src/server.js; keep the default export a router.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { getCurrentUser } from "../auth/index.js";
import { findEvent, store } from "../data.js";

const router = Router();

router.post("/api/events/:eventId/registrations", (req, res) => {
  const user = getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { eventId } = req.params;
  if (!findEvent(eventId)) {
    return res.status(404).json({ error: "Event not found" });
  }

  const existing = store.registrations.find(
    (registration) =>
      registration.eventId === eventId && registration.userId === user.id,
  );
  if (existing) {
    return res.status(409).json({ error: "Already registered" });
  }

  const registration = { id: randomUUID(), eventId, userId: user.id };
  store.registrations.push(registration);
  return res.status(201).json(registration);
});

export default router;
