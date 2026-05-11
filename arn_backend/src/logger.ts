import pino from "pino";

const TRUE = /^(1|true|yes)$/i;

const PINO_LEVELS = new Set<pino.LevelWithSilent>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

function parseLogLevel(): pino.LevelWithSilent {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw && PINO_LEVELS.has(raw as pino.LevelWithSilent)) {
    return raw as pino.LevelWithSilent;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const logPretty = TRUE.test(process.env.LOG_PRETTY?.trim() ?? "");

const baseOptions: pino.LoggerOptions = {
  level: parseLogLevel(),
  base: {
    service: "arn_backend",
    env: process.env.NODE_ENV ?? "development",
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
};

/** Root logger: JSON to async stdout by default; optional pretty transport for local dev (LOG_PRETTY). */
export const logger: pino.Logger = logPretty
  ? pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          singleLine: false,
        },
      },
    })
  : pino(baseOptions, pino.destination({ dest: 1, sync: false }));
