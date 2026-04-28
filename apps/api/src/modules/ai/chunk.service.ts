// ---------------------------------------------------------------------------
// Chunk Service — Production-Grade Text Splitting for RAG Pipeline
// ---------------------------------------------------------------------------
//
// Purpose: Split documents (logs, tickets, runbooks, SaaS support docs) into
// optimally-sized chunks for embedding & semantic retrieval.
//
// Chunking Strategy (why each rule matters):
//
//   1. Target size 300–500 tokens (~225–375 words)
//      → Fits within embedding model context windows
//      → Large enough for semantic meaning, small enough for precise retrieval
//
//   2. Overlap 50–100 tokens (~38–75 words)
//      → Prevents information loss at chunk boundaries
//      → Ensures sentences split across boundaries are recoverable
//
//   3. Paragraph-aware splitting
//      → Preserves natural document structure
//      → Keeps related sentences together (better embeddings)
//
//   4. Minimum chunk size (50 tokens / ~38 words)
//      → Eliminates useless micro-chunks (headers, blank lines)
//      → Avoids noisy, low-signal embeddings
//
//   5. Text cleaning (collapse whitespace, trim, dedup blanks)
//      → Reduces token waste on formatting artifacts
//      → Normalizes content from different upload sources (PDF, Markdown, etc.)
//
// Token Strategy (Day 2 — no tokenizer dependency):
//   We approximate tokens using word count.  Industry heuristic:
//     1 token ≈ 0.75 words (for English text)
//     → words = tokens × 0.75, or tokens ≈ words / 0.75
//   This is accurate enough for chunking. Exact token counts only matter at
//   the embedding step (Day 3), where model-specific tokenizers are used.
//   If precise counts are needed later, swap in tiktoken or similar.
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single processed chunk ready for embedding + DB storage on Day 3. */
export type ProcessedChunk = {
  /** Zero-based position within the source document */
  index: number;
  /** The chunk text content */
  content: string;
  /** Approximate token count (word-based heuristic) */
  tokenCount: number;
  /** Character length of content */
  charCount: number;
  /** SHA-256-style fingerprint for dedup (lightweight: first 12 chars of hash) */
  hash: string;
};

/** Metadata attached to every chunk for multi-tenant vector storage. */
export type ChunkMetadata = {
  sourceId: string;
  sourceType: "document" | "log" | "ticket";
  organizationId: string;
  chunkIndex: number;
  totalChunks: number;
};

/** A chunk with its metadata — the full output of the chunking pipeline. */
export type TextChunk = {
  content: string;
  tokenCount: number;
  metadata: ChunkMetadata;
};

/** Configurable options for the chunking engine. */
export type ChunkOptions = {
  /** Target maximum tokens per chunk (default: 400) */
  maxTokens?: number;
  /** Overlap tokens between consecutive chunks (default: 75) */
  overlap?: number;
  /** Minimum tokens for a chunk to be kept (default: 50) */
  minTokens?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 75;
const DEFAULT_MIN_TOKENS = 50;

/**
 * Heuristic: 1 token ≈ 0.75 English words.
 * We convert between words and tokens using this ratio.
 */
const WORDS_PER_TOKEN = 0.75;

// ---------------------------------------------------------------------------
// Core Public Functions
// ---------------------------------------------------------------------------

/**
 * Clean raw text from uploaded documents.
 *
 * - Collapses multiple blank lines into one
 * - Trims leading/trailing whitespace per line
 * - Removes NULL bytes and control characters (except newlines/tabs)
 * - Normalizes Unicode whitespace
 */
export function cleanText(text: string): string {
  return (
    text
      // Remove NULL bytes and non-printable control chars (keep \n \r \t)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // Normalize Unicode whitespace to regular spaces
      .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ")
      // Trim each line
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Collapse 3+ consecutive newlines into 2 (preserving paragraph breaks)
      .replace(/\n{3,}/g, "\n\n")
      // Final trim
      .trim()
  );
}

/**
 * Estimate token count from text using word-based heuristic.
 *
 * @returns Approximate token count (always ≥ 1 for non-empty text)
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  return Math.max(1, Math.ceil(words.length / WORDS_PER_TOKEN));
}

/**
 * Split text into paragraphs, preserving natural document structure.
 *
 * A "paragraph" is any block of text separated by one or more blank lines.
 * This is the first pass — paragraphs are later merged or split to hit
 * the target chunk size.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split a single long paragraph into smaller pieces by sentence boundaries.
 *
 * Used when a paragraph exceeds maxTokens on its own.
 * Falls back to word-level splitting if no sentence boundaries are found.
 */
export function splitBySentence(text: string, maxWords: number): string[] {
  // Split on sentence-ending punctuation followed by space or newline
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length <= 1) {
    // No sentence boundaries found — fall back to word-level split
    return splitByWords(text, maxWords);
  }

  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const combined = current ? `${current} ${sentence}` : sentence;
    const combinedWords = combined.split(/\s+/).length;

    if (combinedWords > maxWords && current.length > 0) {
      pieces.push(current);
      current = sentence;
    } else {
      current = combined;
    }
  }

  if (current.length > 0) {
    pieces.push(current);
  }

  return pieces;
}

/**
 * Last-resort splitting: break text at word boundaries.
 */
function splitByWords(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const pieces: string[] = [];

  for (let i = 0; i < words.length; i += maxWords) {
    const slice = words.slice(i, i + maxWords);
    pieces.push(slice.join(" "));
  }

  return pieces;
}

/**
 * Generate a simple hash fingerprint for deduplication.
 *
 * Uses a fast non-crypto hash (djb2). Good enough for chunk-level dedup
 * within a single document. Not for security purposes.
 */
function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i);
  }
  // Convert to unsigned 32-bit, then to hex string
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Main Chunking Pipeline
// ---------------------------------------------------------------------------

/**
 * Chunk raw text into embedding-ready pieces.
 *
 * Pipeline:
 *   1. Clean the text (normalize whitespace, strip control chars)
 *   2. Split into paragraphs
 *   3. Merge small paragraphs / split large ones to hit target size
 *   4. Apply overlap between consecutive chunks
 *   5. Filter out chunks below minimum size
 *   6. Deduplicate identical chunks
 *
 * @param text     - Raw document text
 * @param options  - Chunking configuration
 * @returns Array of processed chunks ready for embedding
 */
export function chunkText(
  text: string,
  options?: ChunkOptions
): ProcessedChunk[] {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = options?.overlap ?? DEFAULT_OVERLAP_TOKENS;
  const minTokens = options?.minTokens ?? DEFAULT_MIN_TOKENS;

  // Convert token targets to word counts (our working unit)
  const maxWords = Math.floor(maxTokens * WORDS_PER_TOKEN);
  const overlapWords = Math.floor(overlapTokens * WORDS_PER_TOKEN);
  const minWords = Math.floor(minTokens * WORDS_PER_TOKEN);

  // Step 1: Clean
  const cleaned = cleanText(text);
  if (cleaned.length === 0) return [];

  // Step 2: Paragraph split
  const paragraphs = splitParagraphs(cleaned);
  if (paragraphs.length === 0) return [];

  // Step 3: Build raw segments — merge small paragraphs, split large ones
  const segments = buildSegments(paragraphs, maxWords);

  // Step 4: Apply overlap
  const overlapped = applyOverlap(segments, overlapWords);

  // Step 5 & 6: Filter tiny chunks, deduplicate, build output
  const seen = new Set<string>();
  const chunks: ProcessedChunk[] = [];

  for (const segment of overlapped) {
    const trimmed = segment.trim();
    const wordCount = trimmed.split(/\s+/).filter((w) => w.length > 0).length;

    // Skip chunks below minimum size
    if (wordCount < minWords) continue;

    // Skip duplicate content
    const fingerprint = hashContent(trimmed);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    chunks.push({
      index: chunks.length,
      content: trimmed,
      tokenCount: estimateTokens(trimmed),
      charCount: trimmed.length,
      hash: fingerprint,
    });
  }

  return chunks;
}

/**
 * Full chunking pipeline with metadata — for multi-tenant storage.
 *
 * Wraps `chunkText` and attaches tenant/source metadata to each chunk.
 * This is the function Day 3 will call from the document ingestion pipeline.
 */
export function chunkDocument(
  text: string,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
  options?: ChunkOptions
): TextChunk[] {
  const processed = chunkText(text, options);

  return processed.map((chunk) => ({
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    metadata: {
      ...metadata,
      chunkIndex: chunk.index,
      totalChunks: processed.length,
    },
  }));
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Merge short paragraphs together and split oversized ones.
 *
 * Goal: produce segments that are each close to `maxWords` in length,
 * while respecting paragraph boundaries when possible.
 */
function buildSegments(paragraphs: string[], maxWords: number): string[] {
  const segments: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).filter((w) => w.length > 0).length;

    // If this single paragraph exceeds max, split it further
    if (paraWords > maxWords) {
      // Flush the buffer first
      if (buffer.length > 0) {
        segments.push(buffer.trim());
        buffer = "";
      }
      // Split the oversized paragraph by sentences/words
      const subSegments = splitBySentence(para, maxWords);
      segments.push(...subSegments);
      continue;
    }

    const bufferWords = buffer
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    // If adding this paragraph would exceed max, flush buffer
    if (bufferWords + paraWords > maxWords && buffer.length > 0) {
      segments.push(buffer.trim());
      buffer = para;
    } else {
      // Merge: use double newline to preserve paragraph separation
      buffer = buffer.length > 0 ? `${buffer}\n\n${para}` : para;
    }
  }

  // Don't forget the last buffer
  if (buffer.trim().length > 0) {
    segments.push(buffer.trim());
  }

  return segments;
}

/**
 * Apply sliding-window overlap between consecutive segments.
 *
 * Takes the last N words from the previous chunk and prepends them to the
 * next chunk. This ensures context continuity across chunk boundaries.
 */
function applyOverlap(segments: string[], overlapWords: number): string[] {
  if (segments.length <= 1 || overlapWords <= 0) return segments;

  const result: string[] = [segments[0]!];

  for (let i = 1; i < segments.length; i++) {
    const prevWords = segments[i - 1]!.split(/\s+/).filter((w) => w.length > 0);
    const overlapSlice = prevWords.slice(-overlapWords).join(" ");

    const current = segments[i]!;
    // Prepend overlap context
    result.push(`${overlapSlice} ${current}`.trim());
  }

  return result;
}
