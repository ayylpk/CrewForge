import express from "express";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(healthRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("request failed", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({ code: 500, message: "internal server error" });
  });
  return app;
}
