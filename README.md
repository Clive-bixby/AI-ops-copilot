# OpsPilot AI

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**OpsPilot AI** is a production-grade AI operations copilot that ingests logs, tickets, and internal documents, detects incidents, and answers operational questions with grounded, cited LLM responses.

## Why it stands out
- **End-to-end RAG** — ingestion → chunking → embeddings → pgvector retrieval → cited answers
- **Multi-source intelligence** — documents, logs, and tickets unified into one copilot
- **SaaS-grade backend** — JWT auth, org scoping, RBAC, multi-tenant isolation
- **Async processing** — BullMQ + Redis workers for scalable ingestion/embedding
- **Observability-first UI** — React dashboard, log stream, ticket matrix, document vault, copilot chat

## Architecture
```
apps/
  api/   Express + TypeScript (RAG, ingestion, auth, RBAC, workers)
  web/   React + Vite + Tailwind (dashboard, copilot, logs, tickets, docs)
infra: PostgreSQL (pgvector) + Redis + Docker Compose
```

## Feature highlights
- **RAG Q&A** with citations, confidence scoring, and hallucination reduction
- **Document ingestion** (PDF/TXT/CSV/MD/JSON/LOG) with chunking + embeddings
- **Log pipeline** — ingest, parse, filter, stream
- **Ticket pipeline** — ingest (JSON/CSV), triage, matrix view
- **Semantic search** across all knowledge sources
- **Admin panel** with role-gated access
- **Dockerized** services with cloud-ready config

## Tech stack
| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, Tailwind, React Router |
| Backend | Node.js, Express 5, TypeScript |
| AI | LLM RAG, embeddings, pgvector cosine search |
| Data | PostgreSQL + pgvector |
| Queue | Redis + BullMQ |
| Auth | JWT, org scoping, RBAC |
| DevOps | Docker, Docker Compose |

## Quick start
```bash
# 1. Install
npm install
cd apps/api && npm install
cd ../web && npm install

# 2. Configure
cp apps/api/.env.example apps/api/.env
# set DATABASE_URL, REDIS_URL, JWT_SECRET, GEMINI_API_KEY

# 3. Run
cd apps/api && npm run dev
cd apps/web && npm run dev
```

Or with Docker:
```bash
docker compose up --build
```

## Environment
See `apps/api/.env.example`. Never commit secrets.

## Project structure
```
apps/api/src
  core/        db, queue
  modules/     auth, documents, logs, tickets, ai, admin
  middleware/  auth, org, rbac, upload, error
  workers/     background ingestion
apps/web/src
  pages/       Dashboard, Copilot, Logs, Tickets, Documents, Search, Admin, Settings
  components/  Layout, navigation
```

## Security
- Secrets via environment variables
- JWT auth with org-scoped RBAC
- Uploads and runtime data gitignored

## Author
Built by Aryan Yadav — [GitHub](https://github.com/Clive-bixby)
