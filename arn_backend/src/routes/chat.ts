import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { streamRagChat, type ChatHistoryItem } from "../services/chatService";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(120_000),
});

/** Mongo ObjectId hex format; keeps invalid runIds out of Qdrant filter queries. */
const mongoIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);

const chatRequestSchema = z
  .object({
    message: z.string().min(1).max(16_000),
    history: z.array(chatMessageSchema).max(50).optional().default([]),
    runId: mongoIdSchema.optional(),
    /** When true, RAG includes merge-report vectors; requires runId. */
    includeMergeReportInRag: z.boolean().optional(),
  })
  .refine((data) => data.includeMergeReportInRag !== true || data.runId !== undefined, {
    message: "runId is required when includeMergeReportInRag is true",
    path: ["runId"],
  });

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: z.treeifyError(parsed.error),
    });
    return;
  }

  const { message, history, runId, includeMergeReportInRag } = parsed.data;
  const hist: ChatHistoryItem[] = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as Response & { flushHeaders: () => void }).flushHeaders();
  }

  const writeSse = (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const resWithFlush = res as Response & { flush?: () => void };
    resWithFlush.flush?.();
  };

  try {
    const stream = streamRagChat({
      message,
      history: hist,
      runId,
      ...(includeMergeReportInRag === true ? { includeMergeReportInRag: true } : {}),
    });

    for await (const evt of stream) {
      writeSse(evt);
    }
    writeSse({ type: "done" });
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat failed";
    writeSse({ type: "error", message: msg });
    res.end();
  }
});

export default router;
