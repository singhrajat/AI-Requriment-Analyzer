import "./loadEnv";
import { apiRateLimiter } from "./middleware/apiRateLimiter";
import { attachXRequestIdHeader, httpLogger } from "./middleware/httpLogger";
import { logger } from "./logger";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import mongoose from "mongoose";
import brsRouter from "./routes/brs";
import chatRouter from "./routes/chat";

function configureTrustProxy(application: express.Application): void {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return;
  if (/^(1|true|yes)$/i.test(raw)) {
    application.set("trust proxy", 1);
    return;
  }
  const hops = Number.parseInt(raw, 10);
  if (Number.isFinite(hops) && hops >= 1) {
    application.set("trust proxy", hops);
  }
}

const app = express();
const port = Number(process.env.PORT) || 3000;

configureTrustProxy(app);

app.use(httpLogger);
app.use(attachXRequestIdHeader);

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://ai-requriment-analyzer-production.up.railway.app:3000",
      
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.use("/api", apiRateLimiter);

app.use("/api/brs", brsRouter);
app.use("/api/chat", chatRouter);

// Global error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (req.log) {
    req.log.error({ err }, "unhandled error");
  } else {
    logger.error({ err }, "unhandled error");
  }
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

async function start() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }

  await mongoose.connect(mongoUri);
  logger.info("MongoDB connected");

  app.listen(port, () => {
    logger.info({ port }, "Server listening");
  });
}

start().catch((err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.fatal({ err: e }, "Failed to start server");
  process.exit(1);
});
