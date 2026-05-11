import type { Request, Response, NextFunction } from "express";
import rateLimit, { type Options, type RateLimitInfo } from "express-rate-limit";

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

const windowMs = parsePositiveIntEnv(
  process.env.RATE_LIMIT_WINDOW_MS,
  900_000,
  "RATE_LIMIT_WINDOW_MS"
);
const limit = parsePositiveIntEnv(process.env.RATE_LIMIT_MAX, 100, "RATE_LIMIT_MAX");

export const apiRateLimiter = rateLimit({
  windowMs,
  limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // SSE endpoints are long-lived connections; they should not consume the same
  // short-lived request budget as normal APIs.
  skip: (request: Request) => {
    const path = request.path || "";
    if (path.startsWith("/api/brs/stream")) return true;
    if (path.startsWith("/api/brs/runs/") && path.endsWith("/stream")) return true;
    return false;
  },
  handler: (
    request: Request,
    response: Response,
    _next: NextFunction,
    optionsUsed: Options
  ) => {
    const info = (request as Request & { rateLimit?: RateLimitInfo }).rateLimit;
    const retryAfterSec =
      info?.resetTime !== undefined
        ? Math.max(0, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(optionsUsed.windowMs / 1000);
    response.status(429).json({
      error: "Too many requests",
      retryAfter: retryAfterSec,
    });
  },
});
