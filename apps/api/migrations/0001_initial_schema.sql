-- 0001_initial_schema.sql
--
-- Baseline schema for OpsPilot AI. This migration is the single source of
-- truth for the database shape; ``src/db/schema.sql`` is now only a pointer.
--
-- It is written to be safe against databases created by the old manual
-- ``schema.sql`` import: every object uses IF NOT EXISTS, and the role enum is
-- created inside a guarded DO block. That is what makes ``npm run db:baseline``
-- usable on an existing deployment.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------
-- Organizations
-- -----------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- -----------------------------
-- Users
-- -----------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- -----------------------------
-- Memberships (User ↔ Org)
-- -----------------------------
DO $$
BEGIN
    CREATE TYPE role_type AS ENUM ('owner', 'admin', 'member');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    role role_type DEFAULT 'member',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, organization_id)
);

-- -----------------------------
-- Logs
-- -----------------------------
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    level TEXT,
    message TEXT,
    metadata JSONB,
    timestamp TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- -----------------------------
-- Tickets
-- -----------------------------
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT,
    description TEXT,
    status TEXT,
    priority TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- -----------------------------
-- Documents
-- -----------------------------
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    filename TEXT,
    content TEXT,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    processing_error TEXT,
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_org_processing_status
ON documents (organization_id, processing_status);

-- -----------------------------
-- Document Chunks (pgvector)
-- -----------------------------
-- Embedding dimension must match the configured embedding model.
-- Current default model: nomic-embed-text => 768 dimensions.
CREATE TABLE IF NOT EXISTS document_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(768) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_org_document
ON document_chunks (organization_id, document_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_org
ON document_chunks (organization_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw_cosine
ON document_chunks
USING hnsw (embedding vector_cosine_ops);
