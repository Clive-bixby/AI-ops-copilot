# AI Ops Copilot

A full-stack AI operations copilot: a Node/Express API with RAG, document ingestion, log and ticket pipelines, and a React web frontend.

## Structure

- `apps/api` — Express + TypeScript backend (RAG, embeddings, documents, logs, tickets, auth, RBAC)
- `apps/web` — React + Vite + Tailwind frontend

## Getting started

```bash
npm install
cd apps/api && npm install
cd ../web && npm install
```

### API

```bash
cd apps/api
cp .env.example .env  # configure DB, Redis, LLM keys
npm run dev
```

Requires PostgreSQL (with pgvector) and Redis. See `apps/api/Dockerfile`.

### Web

```bash
cd apps/web
npm run dev
```

## Features

- Document upload, chunking, embeddings, and vector retrieval
- RAG ask endpoint with citations and hallucination reduction
- Log ingestion and parsing
- Ticket ingestion pipeline
- Auth, org, and RBAC middleware
- Admin routes and AI metrics
- React dashboard, copilot, documents, logs pages

## Scripts

- API: `npm run dev` (tsx watch)
- Web: `npm run dev`, `npm run build`, `npm run lint`, `npm run preview`
