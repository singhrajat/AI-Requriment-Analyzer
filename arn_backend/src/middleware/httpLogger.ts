import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import pino from "pino";
import pinoHttp from "pino-http";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger";

const REQUEST_ID_HEADER = (process.env.REQUEST_ID_HEADER ?? "x-request-id").toLowerCase();

function incomingRequestId(req: IncomingMessage): string | undefined {
  const raw = req.headers[REQUEST_ID_HEADER];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().slice(0, 256);
  }
  if (Array.isArray(raw) && raw[0]?.trim()) {
    return raw[0].trim().slice(0, 256);
  }
  return undefined;
}

/** pino-http: assigns req.id / req.log, auto-logs request completion with timing. */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, _res: ServerResponse) =>
    incomingRequestId(req) ?? randomUUID(),
  serializers: {
    err: pino.stdSerializers.err,
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req: IncomingMessage, res: ServerResponse, responseTime: number) =>
    `${req.method} ${req.url ?? ""} ${res.statusCode} ${responseTime}ms`,
  customErrorMessage: (req: IncomingMessage, res: ServerResponse, err: Error) =>
    `${req.method} ${req.url ?? ""} ${res.statusCode} — ${err.message}`,
});

/** Echo correlation id on the response (pino-http does not set this header by default). */
export function attachXRequestIdHeader(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Request-Id", String(req.id));
  next();
}
