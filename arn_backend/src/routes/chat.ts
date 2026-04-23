import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { streamDirectChat, streamRagChat, type ChatHistoryItem } from "../services/chatService";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(120_000),
});

const chatRequestSchema = z.object({
  message: z.string().min(1).max(16_000),
  useDbSearch: z.boolean(),
  history: z.array(chatMessageSchema).max(50).optional().default([]),
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

  const { message, useDbSearch, history } = parsed.data;
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
  };

  try {
    const stream = useDbSearch
      ? streamRagChat({ message, history: hist })
      : streamDirectChat({ message, history: hist });

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
