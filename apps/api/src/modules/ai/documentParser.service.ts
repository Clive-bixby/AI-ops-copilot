import fs from "fs/promises";
import path from "path";

import { PDFParse } from "pdf-parse";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export class DocumentParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentParserError";
  }
}

async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function readPdfFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function parseDocument(filePath: string): Promise<string> {
  const normalizedPath = (filePath || "").trim();
  if (!normalizedPath) {
    throw new DocumentParserError("File path is required");
  }

  let stats;
  try {
    stats = await fs.stat(normalizedPath);
  } catch {
    throw new DocumentParserError("Uploaded file could not be found");
  }

  if (!stats.isFile()) {
    throw new DocumentParserError("Uploaded path is not a file");
  }

  if (stats.size === 0) {
    throw new DocumentParserError("Uploaded file is empty");
  }

  if (stats.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentParserError(
      `Uploaded file exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit`
    );
  }

  const extension = path.extname(normalizedPath).toLowerCase();

  try {
    const text =
      extension === ".txt"
        ? await readTextFile(normalizedPath)
        : extension === ".pdf"
          ? await readPdfFile(normalizedPath)
          : "";

    if (!text) {
      throw new DocumentParserError(
        "Unsupported document format. Supported formats: .txt, .pdf"
      );
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new DocumentParserError("Document did not contain extractable text");
    }

    return trimmed;
  } catch (error) {
    if (error instanceof DocumentParserError) {
      throw error;
    }

    throw new DocumentParserError(
      error instanceof Error
        ? `Failed to parse document: ${error.message}`
        : "Failed to parse document"
    );
  }
}
