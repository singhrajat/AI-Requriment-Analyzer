# AI Requirement Analyzer (ARN)

> An intelligent, multi-agent pipeline that analyzes Business Requirements Specification (BRS) documents, generates structured developer and PM checklists, performs AI-powered review, and exposes a RAG-enabled chat interface over past analysis runs.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Project Structure](#project-structure)
- [Pipeline Deep Dive](#pipeline-deep-dive)
- [API Reference](#api-reference)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
- [Environment Variables](#environment-variables)
- [Key Design Decisions](#key-design-decisions)

---

## Overview

ARN automates the tedious first pass of analyzing a BRS document. A product manager or developer uploads a `.pdf`, `.docx`, `.doc`, or `.txt` requirements document. The system then:

1. Extracts and chunks the document text (LangChain `RecursiveCharacterTextSplitter`).
2. Embeds it with OpenAI and upserts vectors into **Qdrant** (metadata in MongoDB).
3. Runs a **LangGraph state machine** with specialized OpenAI agents — a **Fetch agent**, a **Developer agent**, a **PM agent**, and a **Reviewer agent** — in the correct dependency order, with automatic retry logic.
4. Produces a merged, structured report that can be exported to `.docx`.
5. Makes all past runs queryable through a **streaming RAG chat** interface backed by vector similarity search.

---

## Architecture

```
                          ┌─────────────────────────────────────────┐
                          │           LangGraph State Machine        │
                          │                                           │
  Upload BRS Doc          │  embedAndMeasure → fetchSmall            │
  (PDF/DOCX/TXT)  ──────► │                 └─ chunkAndFetch         │
                          │                         │                 │
                          │              ┌──────────┴──────────┐      │
                          │              ▼                      ▼      │
                          │          devAgent              pmAgent     │
                          │              └──────────┬──────────┘      │
                          │                         ▼                  │
                          │                   reviewerAgent            │
                          │                  (Zod-validated)           │
                          │                    /        \              │
                          │             ready?            needs retry? │
                          │               ▼                    ▼       │
                          │          mergeAgents        selectiveRerun │
                          │               ▼             (max 2 loops)  │
                          │        Structured Report                   │
                          └─────────────────────────────────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │  MongoDB (Mongoose)           │
                          │  - Run documents + metadata   │
                          │  - Stage outputs & history    │
                          └──────────────┬───────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │  Qdrant (vector store)      │
                          │  OpenAI text-embedding-3      │
                          └──────────────┬───────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │  RAG Chat  (LlamaIndex +     │
                          │  LangChain streaming SSE)    │
                          └─────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend runtime** | Node.js ≥ 20, TypeScript, Express |
| **AI orchestration** | LangChain, LangGraph (state machine) |
| **LLM** | OpenAI (GPT-4o, GPT-4.1, o4-mini per role) |
| **Embeddings** | OpenAI (`OPENAI_EMBEDDING_MODEL`, e.g. `text-embedding-3-large`) |
| **Vector store** | Qdrant (cosine similarity; chunk text in payload) |
| **RAG** | LlamaIndex (`getResponseSynthesizer`), Qdrant retrieval |
| **Observability** | Langfuse (tracing per pipeline span) |
| **Database** | MongoDB / Mongoose |
| **Schema validation** | Zod |
| **Document parsing** | `pdf-parse`, `mammoth` (DOCX/DOC) |
| **Document export** | `docx` library |
| **Token counting** | `js-tiktoken` |
| **File upload** | Multer |
| **Rate limiting** | `express-rate-limit` |
| **Frontend** | React 19, TypeScript, Vite 7, react-router-dom |

---

## Features

- **Multi-format document ingestion** — PDF, DOCX, DOC, TXT
- **Adaptive chunking** — automatically switches between single-pass ("small") and chunk-based ("large") pipelines based on a configurable token threshold; large docs use LangChain recursive splitting (`CHUNK_SIZE` / `CHUNK_OVERLAP`)
- **Role-based agents** — separate OpenAI models for Fetch, Developer, PM, and Reviewer roles, each configurable independently via env
- **Reviewer with retry loops** — the Reviewer agent validates outputs with a Zod schema; blocking issues trigger a selective rerun (up to 2 iterations) before an escalation flag is set
- **Human-in-the-loop escalation** — runs that exceed retry limits enter `awaiting_user_decision` status; users can `save` or `discard` the merged result via the UI
- **Pipeline control** — `stop` / `resume` endpoints per run
- **DOCX export** — download the final structured report as a formatted Word document
- **RAG chat** — streaming SSE chat that can answer questions across all past BRS runs using vector similarity, with source citations
- **Direct chat** — simple streaming chat without retrieval
- **Langfuse tracing** — every pipeline node is wrapped in a Langfuse span for full LLM observability
- **API rate limiting** — configurable window / max-requests per IP on all `/api/*` routes

---

## Project Structure

```
AI-Requirement-Analyzer/
├── arn_backend/                  # Express API + LangGraph pipeline
│   ├── src/
│   │   ├── index.ts              # App entry, Express setup, MongoDB connect
│   │   ├── loadEnv.ts            # dotenv bootstrap (multi-path)
│   │   ├── config/
│   │   │   └── modelConfig.ts    # OpenAI clients, Langfuse singleton, env guards
│   │   ├── middleware/
│   │   │   └── apiRateLimiter.ts
│   │   ├── models/
│   │   │   └── BrsPipelineRun.ts # Mongoose schema for runs + embeddings
│   │   ├── prompts/
│   │   │   ├── brsPipelinePrompts.ts  # Agent prompt templates
│   │   │   └── chatPrompts.ts         # Chat system/user templates
│   │   ├── routes/
│   │   │   ├── brs.ts            # BRS REST endpoints + SSE progress
│   │   │   └── chat.ts           # Chat SSE endpoint
│   │   ├── schemas/
│   │   │   └── brsReviewerOutput.ts   # Zod schema for reviewer output
│   │   └── services/
│   │       ├── brsPipelineGraph.ts    # LangGraph state machine (core)
│   │       ├── brsRunDocxExport.ts    # DOCX export builder
│   │       ├── brsStructuredOutputDocx.ts
│   │       ├── chatService.ts         # RAG + direct chat, Qdrant retriever
│   │       ├── brsRecursiveChunk.ts   # LangChain RecursiveCharacterTextSplitter
│   │       ├── qdrantBrsStore.ts      # Qdrant upsert / search / delete by run
│   │       ├── extractDocumentText.ts # PDF/DOCX/DOC/TXT → plain text
│   │       └── tokenCounter.ts        # tiktoken helpers + threshold check
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
│
└── arn_frontend/                 # React + Vite SPA
    └── src/
        ├── api/                  # Typed API clients (brs.ts, chat.ts)
        ├── components/           # UI components (Pipeline tracker, Agent outputs grid, Chat widget, etc.)
        ├── pages/                # Route-level pages (Dashboard, Submit, Submissions, Run detail, Settings)
        └── utils/
```

---

## Pipeline Deep Dive

### State Machine Nodes

| Node | Description |
|---|---|
| `embedAndMeasure` | Classifies input as small/large, chunks if needed, generates Voyage embeddings, persists to MongoDB |
| `fetchSmall` | Runs Fetch agent on the full document (small path) |
| `chunkAndFetch` | Runs Fetch agent per chunk then merges outputs (large path) |
| `devAgent` | Developer checklist agent — technical feasibility, dependencies, edge cases |
| `pmAgent` | PM checklist agent — scope, acceptance criteria, stakeholder concerns |
| `reviewerAgent` | Reviews both agent outputs; Zod-validates JSON; emits `ready_for_merge` or blocking issues with responsible agent |
| `selectiveRerun` | Reruns only the agent(s) with blocking issues (max 2 iterations) |
| `mergeAgents` | Merges dev + PM outputs into a unified report; sets escalation flag if retry limit hit |

### Routing Logic

```
reviewerAgent
  ├─ ready_for_merge = true  →  mergeAgents
  └─ ready_for_merge = false
        ├─ retries < 2  →  selectiveRerun  →  (devAgent | pmAgent | both)  →  reviewerAgent
        └─ retries >= 2 →  mergeAgents (escalated = true, status = awaiting_user_decision)
```

---

## API Reference

### BRS Endpoints (`/api/brs`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/runs` | Upload BRS document (multipart), start pipeline |
| `GET` | `/runs` | List all runs |
| `GET` | `/runs/:id` | Get run details + stage outputs |
| `GET` | `/runs/:id/export` | Download structured report as DOCX |
| `POST` | `/runs/:id/decision` | `{ action: "save" | "discard" }` for escalated runs |
| `POST` | `/runs/:id/control` | `{ action: "stop" | "resume" }` |
| `GET` | `/health` | Health check (not rate-limited) |

### Chat Endpoint (`/api/chat`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/` | Start streaming chat; body `{ message, history? }`; always retrieves from the BRS vector index then streams the model; SSE `text/event-stream` with `token`, `sources`, and `done` events |

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- MongoDB (local or Atlas)
- OpenAI API key
- Qdrant reachable at `QDRANT_URL` (e.g. local Docker: `docker run -p 6333:6333 qdrant/qdrant`)
- (Optional) Langfuse account for tracing

### Backend Setup

```bash
cd arn_backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys and MongoDB URI

# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

The server starts on `http://localhost:3000` (or `PORT` from `.env`).

### Frontend Setup

```bash
cd arn_frontend

# Install dependencies
npm install

# Create env file (optional — falls back to http://localhost:3000)
echo "VITE_API_BASE_URL=http://localhost:3000" > .env

# Development
npm run dev

# Production build
npm run build
```

The Vite dev server starts on `http://localhost:5173` by default.

---

## Environment Variables

All backend configuration lives in `arn_backend/.env` (copy from `.env.example`).

```env
# Server
PORT=3000

# Rate limiting
RATE_LIMIT_WINDOW_MS=900000   # 15 minutes
RATE_LIMIT_MAX=100

# MongoDB (required)
MONGO_URI=mongodb://localhost:27017/arn_db

# OpenAI (required)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o              # General / merge step
OPENAI_FETCH_MODEL=gpt-4o        # Fetch agent
OPENAI_DEV_MODEL=gpt-4.1         # Developer agent
OPENAI_PM_MODEL=gpt-4.1          # PM agent
OPENAI_TEMPERATURE=0
OPENAI_MAX_TOKENS=8000
OPENAI_BRS_REVIEWER_MODEL=o4-mini   # Reasoning model for reviewer

# BRS pipeline tuning
BRS_SMALL_INPUT_TOKEN_THRESHOLD=4000
CHUNK_SIZE=1500
CHUNK_OVERLAP=200

# OpenAI embeddings + Qdrant (required for indexing / RAG)
OPENAI_EMBEDDING_MODEL=text-embedding-3-large
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION_NAME=arn_brs

# Langfuse tracing (optional)
LANGFUSE_HOST=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

Frontend:

```env
# arn_frontend/.env
VITE_API_BASE_URL=http://localhost:3000
```

---

## Key Design Decisions

**Role-based model routing** — each pipeline agent uses its own independently configurable model. This lets you assign a cheaper/faster model to the Fetch agent and a stronger reasoning model (e.g. `o4-mini`) to the Reviewer without touching code.

**LangGraph for deterministic flow control** — using a compiled `StateGraph` gives explicit, inspectable routing between nodes and makes it straightforward to add new agent roles or change the retry threshold.

**Adaptive small/large pipeline** — documents below a configurable token threshold are processed in a single LLM call; larger documents are chunked and processed in parallel chunks before merging. This balances cost vs. context-window constraints.

**Human-in-the-loop escalation** — rather than silently accepting low-confidence merges, the system flags escalated runs and gates the final report behind an explicit user `save / discard` decision.

**OpenAI + Qdrant** — document and merged-report passages are embedded with `OPENAI_EMBEDDING_MODEL` and stored in Qdrant with full text in the payload for retrieval; MongoDB keeps run metadata only.

**Legacy runs** — documents created before this stack used in-Mongo Voyage vectors only; they are **not** searchable via Qdrant until you re-process those runs or run a one-off re-index that re-embeds `documentText` / `mergedReport` into the collection.

**Langfuse observability** — every node emits a span with model, prompt, and latency data, making it easy to audit token usage, cost, and failure modes in production.
