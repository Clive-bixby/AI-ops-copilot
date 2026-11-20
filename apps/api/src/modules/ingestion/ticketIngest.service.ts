import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { embedTexts } from "./embed.service.js";
import { getEmbeddingConfig, hashContent } from "./embeddingConfig.js";
import { IngestionValidationError, SourceNotFoundError } from "./errors.js";
import { replaceSourceIndex } from "./sourceIndex.service.js";

export type TicketIngestResult = {
  status: "indexed" | "unchanged";
  ticketId: string;
  chunkCount: number;
  embeddedChunkCount: number;
  contentHash: string;
};

type TicketRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
  content_hash: string | null;
};

/**
 * The searchable form of a ticket. One chunk: tickets are short, and splitting
 * a title from its description would let half a ticket answer a question.
 */
export function renderTicketContent(ticket: {
  title: string;
  description: string | null;
  status: string;
  priority: string;
}): string {
  return [
    `Ticket: ${ticket.title}`,
    `Status: ${ticket.status}`,
    `Priority: ${ticket.priority}`,
    ticket.description ? `Description: ${ticket.description}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function indexTicket(input: {
  organizationId: string;
  ticketId: string;
}): Promise<TicketIngestResult> {
  const organizationId = (input.organizationId || "").trim();
  const ticketId = (input.ticketId || "").trim();

  if (!organizationId) {
    throw new IngestionValidationError("Organization ID is required");
  }

  if (!ticketId) {
    throw new IngestionValidationError("Ticket ID is required");
  }

  const result = await pool.query<TicketRow>(
    `SELECT id, title, description, status, priority, created_at, content_hash
     FROM tickets
     WHERE id = $1 AND organization_id = $2`,
    [ticketId, organizationId]
  );

  const ticket = result.rows[0];
  if (!ticket) {
    throw new SourceNotFoundError("Ticket not found");
  }

  const content = renderTicketContent(ticket);
  const contentHash = hashContent(content);
  const config = getEmbeddingConfig();

  const current = await pool.query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM source_chunks
       WHERE organization_id = $1 AND source_type = 'ticket' AND source_id = $2
         AND embedding_model = $3 AND embedding_dimensions = $4
     ) AS current`,
    [organizationId, ticketId, config.model, config.dimensions]
  );

  if (ticket.content_hash === contentHash && current.rows[0]?.current === true) {
    logger.info("ingestion.ticket_unchanged", {
      organizationId,
      ticketId,
      contentHash,
    });

    return {
      status: "unchanged",
      ticketId,
      chunkCount: 1,
      embeddedChunkCount: 0,
      contentHash,
    };
  }

  const [embedding] = await embedTexts([content]);
  if (!embedding) {
    throw new IngestionValidationError("Ticket embedding was not produced");
  }

  const stored = await replaceSourceIndex({
    organizationId,
    sourceType: "ticket",
    sourceId: ticketId,
    sourceCreatedAt: ticket.created_at,
    chunks: [
      {
        index: 0,
        content,
        chunkHash: contentHash,
        metadata: {
          sourceType: "ticket",
          sourceId: ticketId,
          status: ticket.status,
          priority: ticket.priority,
        },
      },
    ],
    embeddings: [embedding.embedding],
    config,
  });

  await pool.query(
    `UPDATE tickets SET content_hash = $3 WHERE id = $1 AND organization_id = $2`,
    [ticketId, organizationId, contentHash]
  );

  logger.info("ingestion.ticket_indexed", {
    organizationId,
    ticketId,
    chunkCount: stored,
    embeddingModel: config.model,
  });

  return {
    status: "indexed",
    ticketId,
    chunkCount: stored,
    embeddedChunkCount: 1,
    contentHash,
  };
}
