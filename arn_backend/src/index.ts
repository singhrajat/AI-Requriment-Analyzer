import "./loadEnv";
import { apiRateLimiter } from "./middleware/apiRateLimiter";
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

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://ai-requirement-analyzer-prod.up.railway.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

async function start() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }

  await mongoose.connect(mongoUri);
  console.log("MongoDB connected");

  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
