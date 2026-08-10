import { Hono } from "hono";

import { buildHealthPayload } from "../shared/health";

const app = new Hono();

app.get("/api/health", (context) => context.json(buildHealthPayload()));

export default app;
