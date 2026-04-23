import dotenv from "dotenv";
import fs from "fs";
import path from "path";

const envCandidates = [
  path.resolve(__dirname, "..", ".env"), // `dist/` -> `arn_backend/.env`
  path.resolve(__dirname, ".env"), // `arn_backend/` -> `arn_backend/.env`
  path.resolve(process.cwd(), ".env"), // fallback: current working directory
];
const envPath = envCandidates.find((p) => fs.existsSync(p));
const envResult = dotenv.config(envPath ? { path: envPath } : undefined);
if (envResult.error) {
  throw envResult.error;
}
