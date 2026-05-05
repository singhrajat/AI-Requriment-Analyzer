import mongoose, { Document, Schema } from "mongoose";

export type StageStatus = "pending" | "running" | "done" | "error";
export type InputSizeClass = "small" | "large";
export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "error"
  | "needs_human_review"
  | "awaiting_user_decision";

export type MergeSource = "reviewer_approved" | "escalated_after_max_retries";

export interface IReviewOutputEntry {
  attempt: number;
  output: string;
  createdAt: Date;
}

export interface IBrsPipelineRun extends Document {
  status: RunStatus;
  control?: {
    stopRequestedAt?: Date;
    pausedAt?: Date;
  };
  inputSizeClass?: InputSizeClass;
  chunkCount?: number;
  chunkMergeStatus?: "ok" | "error";
  chunkMergeError?: string;
  /** Extracted text content from the uploaded BRS document. */
  documentText?: string;
  embeddings?: {
    brs?: {
      provider: string;
      model: string;
      strategy: "single" | "chunked";
      /** Legacy Voyage-era documents only; new runs index vectors in Qdrant. */
      vector?: number[];
      chunks?: Array<{
        index: number;
        charStart: number;
        charEnd: number;
        vector: number[];
      }>;
      createdAt: Date;
    };
    mergedReport?: {
      provider: string;
      model: string;
      /** Legacy only */
      vector?: number[];
      createdAt: Date;
    };
  };
  stages: {
    fetch: StageStatus;
    dev: StageStatus;
    pm: StageStatus;
    /** Omitted on legacy runs created before the reviewer gate existed. */
    review?: StageStatus;
    merge: StageStatus;
  };
  fetchOutput?: string;
  devOutput?: string;
  pmOutput?: string;
  mergedReport?: string;
  /** Set when merge completed after reviewer approved (no user gate). */
  mergeSource?: MergeSource;
  /** True when merge was produced after max review retries; user must save or discard. */
  awaitingUserDecision?: boolean;
  review_outputs?: IReviewOutputEntry[];
  error?: string;
  /** Optional user-provided friendly name for the uploaded BRS. */
  displayName?: string;
  originalFileName?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

const stageStatusEnum = ["pending", "running", "done", "error"];

const ReviewOutputEntrySchema = new Schema<IReviewOutputEntry>(
  {
    attempt: { type: Number, required: true },
    output: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const BrsPipelineRunSchema = new Schema<IBrsPipelineRun>(
  {
    status: {
      type: String,
      enum: ["queued", "running", "paused", "done", "error", "needs_human_review", "awaiting_user_decision"],
      default: "queued",
      required: true,
    },
    control: {
      stopRequestedAt: { type: Date },
      pausedAt: { type: Date },
    },
    inputSizeClass: {
      type: String,
      enum: ["small", "large"],
    },
    chunkCount: { type: Number },
    chunkMergeStatus: { type: String, enum: ["ok", "error"] },
    chunkMergeError: { type: String },
    documentText: { type: String },
    embeddings: {
      brs: {
        provider: { type: String },
        model: { type: String },
        strategy: { type: String, enum: ["single", "chunked"] },
        vector: { type: [Number] },
        chunks: {
          type: [
            new Schema(
              {
                index: { type: Number, required: true },
                charStart: { type: Number, required: true },
                charEnd: { type: Number, required: true },
                vector: { type: [Number], required: true },
              },
              { _id: false }
            ),
          ],
          default: undefined,
        },
        createdAt: { type: Date },
      },
      mergedReport: {
        provider: { type: String },
        model: { type: String },
        vector: { type: [Number] },
        createdAt: { type: Date },
      },
    },
    stages: {
      fetch: { type: String, enum: stageStatusEnum, default: "pending" },
      dev: { type: String, enum: stageStatusEnum, default: "pending" },
      pm: { type: String, enum: stageStatusEnum, default: "pending" },
      review: { type: String, enum: stageStatusEnum, default: "pending" },
      merge: { type: String, enum: stageStatusEnum, default: "pending" },
    },
    fetchOutput: { type: String },
    devOutput: { type: String },
    pmOutput: { type: String },
    mergedReport: { type: String },
    mergeSource: {
      type: String,
      enum: ["reviewer_approved", "escalated_after_max_retries"],
    },
    awaitingUserDecision: { type: Boolean },
    review_outputs: { type: [ReviewOutputEntrySchema], default: [] },
    error: { type: String },
    displayName: { type: String },
    originalFileName: { type: String },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

export const BrsPipelineRun = mongoose.model<IBrsPipelineRun>(
  "BrsPipelineRun",
  BrsPipelineRunSchema
);
