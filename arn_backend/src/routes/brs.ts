import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { BrsPipelineRun } from "../models/BrsPipelineRun";
import { extractDocumentText } from "../services/extractDocumentText";
import { launchBrsPipeline } from "../services/brsPipelineGraph";
import {
  deleteMergeReportPointsForRun,
  deleteQdrantPointsForRun,
} from "../services/qdrantBrsStore";
import { embedMergeReportForRun } from "../services/mergeReportRagChunks";
import { buildBrsRunDocxBuffer, safeDocxAttachmentName } from "../services/brsRunDocxExport";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter(_req, file, cb) {
    const allowed = [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Upload a PDF, TXT, or DOCX."));
    }
  },
});

// POST /api/brs/submit
router.post(
  "/submit",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded." });
        return;
      }

      const displayName =
        typeof req.body?.displayName === "string" && req.body.displayName.trim().length > 0
          ? req.body.displayName.trim().slice(0, 140)
          : undefined;

      const run = await BrsPipelineRun.create({
        status: "queued",
        displayName,
        originalFileName: req.file.originalname,
        stages: {
          fetch: "pending",
          dev: "pending",
          pm: "pending",
          review: "pending",
          merge: "pending",
        },
      });

      const runId = run._id.toString();

      // Extract text and launch pipeline asynchronously
      extractDocumentText(req.file.buffer, req.file.mimetype)
        .then((documentText) => launchBrsPipeline(runId, documentText))
        .catch(async (err: Error) => {
          console.error(`Text extraction failed for run ${runId}:`, err);
          await BrsPipelineRun.findByIdAndUpdate(runId, {
            $set: { status: "error" },
          });
        });

      res.status(201).json({ runId });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/brs/runs
router.get("/runs", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const runs = await BrsPipelineRun.find().sort({ createdAt: -1 }).limit(50).lean();

    const total = await BrsPipelineRun.countDocuments();
    const inPipeline = await BrsPipelineRun.countDocuments({ status: "running" });
    const reportsReady = await BrsPipelineRun.countDocuments({ status: "done" });

    const completedRuns = await BrsPipelineRun.find({
      status: "done",
      completedAt: { $exists: true },
    })
      .select("createdAt completedAt")
      .lean();

    const avgDuration =
      completedRuns.length > 0
        ? completedRuns.reduce((sum, r) => {
            const duration =
              new Date(r.completedAt!).getTime() - new Date(r.createdAt).getTime();
            return sum + duration;
          }, 0) / completedRuns.length
        : 0;

    res.json({
      runs,
      stats: { total, inPipeline, reportsReady, avgDuration },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/brs/runs/:id/export.docx
router.get(
  "/runs/:id/export.docx",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const run = await BrsPipelineRun.findById(req.params.id).lean();
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      let buffer: Buffer;
      try {
        buffer = await buildBrsRunDocxBuffer(run);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("DOCX export is unavailable until you save or discard")
        ) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
      const filename = safeDocxAttachmentName(run.displayName ?? run.originalFileName, run._id.toString());
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }
);

const RunDecisionBodySchema = z.object({
  action: z.enum(["save", "discard"]),
});

// POST /api/brs/runs/:id/decision — accept or discard escalated merge
router.post(
  "/runs/:id/decision",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RunDecisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Body must be { action: 'save' | 'discard' }." });
        return;
      }

      const run = await BrsPipelineRun.findById(req.params.id);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      if (run.status !== "awaiting_user_decision" || !run.awaitingUserDecision) {
        res.status(400).json({ error: "Run is not awaiting a merge decision." });
        return;
      }

      if (parsed.data.action === "save") {
        run.status = "done";
        run.completedAt = new Date();
        run.awaitingUserDecision = false;
        await run.save();
        try {
          await embedMergeReportForRun(run._id.toString());
        } catch (embedErr) {
          console.error(`[brs] merge embed failed for run ${run._id}:`, embedErr);
        }
        res.json({ ok: true, status: run.status });
        return;
      }

      run.mergedReport = undefined;
      run.mergeSource = undefined;
      run.awaitingUserDecision = false;
      run.stages.merge = "pending";
      run.status = "needs_human_review";
      await run.save();
      try {
        await deleteMergeReportPointsForRun(run._id.toString());
      } catch (delErr) {
        console.error(`[brs] merge points delete failed for run ${run._id}:`, delErr);
      }
      res.json({ ok: true, status: run.status });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/brs/runs/:id
router.get("/runs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = await BrsPipelineRun.findById(req.params.id).lean();
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err) {
    next(err);
  }
});

const RunControlBodySchema = z.object({
  action: z.enum(["stop", "resume"]),
});

// POST /api/brs/runs/:id/control — stop (pause) or resume a run
router.post("/runs/:id/control", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = RunControlBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body must be { action: 'stop' | 'resume' }." });
      return;
    }

    const run = await BrsPipelineRun.findById(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    if (parsed.data.action === "stop") {
      if (run.status === "done" || run.status === "error" || run.status === "needs_human_review" || run.status === "awaiting_user_decision") {
        res.status(409).json({ error: `Run cannot be stopped from status '${run.status}'.` });
        return;
      }
      run.status = "paused" as any;
      run.control = {
        ...(run.control ?? {}),
        stopRequestedAt: new Date(),
        pausedAt: new Date(),
      };
      // If something was mid-stage, clear "running" back to pending so resume can re-run cleanly.
      for (const key of ["fetch", "dev", "pm", "review", "merge"] as const) {
        const current = (run.stages as any)?.[key];
        if (current === "running") (run.stages as any)[key] = "pending";
      }
      await run.save();
      res.json({ ok: true, status: run.status });
      return;
    }

    // resume
    if (run.status !== ("paused" as any)) {
      res.status(409).json({ error: "Run is not paused." });
      return;
    }
    if (!run.documentText || run.documentText.trim().length === 0) {
      res.status(409).json({ error: "Run cannot be resumed (missing extracted document text)." });
      return;
    }

    run.status = "running" as any;
    if (run.control) {
      run.control.stopRequestedAt = undefined;
      run.control.pausedAt = undefined;
    }
    // Clear stale "running" flags defensively.
    for (const key of ["fetch", "dev", "pm", "review", "merge"] as const) {
      const current = (run.stages as any)?.[key];
      if (current === "running") (run.stages as any)[key] = "pending";
    }
    await run.save();

    // Fire-and-forget resume from stored document text.
    void launchBrsPipeline(run._id.toString(), run.documentText);

    res.json({ ok: true, status: run.status });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/brs/runs/:id
router.delete("/runs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    const existing = await BrsPipelineRun.findById(id).select("_id").lean();
    if (!existing) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    try {
      await deleteQdrantPointsForRun(id);
    } catch (qErr) {
      console.error(`Qdrant delete failed for run ${id}:`, qErr);
    }
    await BrsPipelineRun.deleteOne({ _id: id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
