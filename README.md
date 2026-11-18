# AI Ops Copilot

An AI-powered operations copilot for IT/support teams. Ingest documents, logs, and tickets; retrieve relevant context with vector search; and answer questions through a RAG pipeline with citations and hallucination reduction.

## Highlights

- **RAG Q&A** — Ask endpoint backed by an LLM, with citations and hallucination reduction
- **Document ingestion** — Upload PDFs, chunk, embed, and store in pgvector for semantic retrieval
- **Log pipeline** — Ingest and parse operational logs for analysis
- **Ticket pipeline** — Ingest support tickets for triage and search
- **Multi-tenant auth** — JWT auth, org scoping, RBAC, admin routes
- **Async processing** — BullMQ + Redis for background jobs
- **Metrics** — AI usage/latency metrics tracking
- **Web UI** — React dashboard, copilot chat, documents, and logs views

## Architecture

```
apps/
  api/   Express + TypeScript backend (RAG, embeddings, ingestion, auth, RBAC)
  web/   React + Vite + Tailwind frontend
```

- **Database:** PostgreSQL + pgvector
- **Queue/Cache:** Redis + BullMQ
- **LLM/Embeddings:** configurable providers (via env)

## Getting started

### Prerequisites

- Node.js 18+
- PostgreSQL with pgvector extension
- Redis

### Setup

```bash
npm install
cd apps/api && npm install
cd ../web && npm install
```

Configure `apps/api/.env` (see below), then:

```bash
# API
cd apps/api && npm run dev

# Web (new terminal)
cd apps/web && npm run dev
```

### Environment

Create `apps/api/.env`:

```env
PORT=3000
DATABASE_URL=postgres://user:pass@localhost:5432/aiops
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret
LLM_API_KEY=your-key
EMBEDDING_API_KEY=your-key
```

Do not commit `.env` files or API keys.

## Scripts

- API: `npm run dev` (tsx watch)
- Web: `npm run dev`, `npm run build`, `npm run lint`, `npm run preview`

## Security

- Secrets are loaded from environment variables; never committed.
- Uploads and docker data are gitignored.
- Auth enforced via middleware with org scoping and RBAC.
