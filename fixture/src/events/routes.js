// Event registration. Mounted by src/server.js; keep the default export a router.
import { Router } from "express";

const router = Router();

router.post("/api/events/:eventId/registrations", (_req, res) => {
  res.status(501).json({ error: "Not implemented" });
});

export default router;
