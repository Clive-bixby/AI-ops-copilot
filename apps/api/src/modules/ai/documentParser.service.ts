import fs from "fs/promises";
import path from "path";

import { PDFParse } from "pdf-parse";

import { MAX_DOCUMENT_BYTES } from "../../config/limits.js";

export class DocumentParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentParserError";
  }
}

/** Extensions whose content is text, by contract with the upload filter. */
const TEXT_UPLOAD_EXTENSIONS = new Set([
  ".txt",
  ".csv",
  ".md",
  ".json",
  ".log",
  ".tsv",
]);

/**
 * Reject a file whose bytes disagree with the extension it was uploaded under.
 *
 * The upload filter only ever sees a filename, so a binary renamed `.log` or a
 * non-PDF renamed `.pdf` used to be accepted and handed to a parser, where it
 * failed asynchronously inside a job the user had already been told was queued.
 * Sniffing the content costs nothing extra here — the upload path already reads
 * these bytes to compute the dedupe hash — and turns that deferred failure into
 * a 400 on the request that caused it.
 */
export function assertContentMatchesExtension(
  extension: string,
  bytes: Uint8Array
): void {
  const normalized = extension.trim().toLowerCase();

  if (normalized === ".pdf") {
    const header = Buffer.from(bytes.subarray(0, 5)).toString("latin1");

    if (header !== "%PDF-") {
      throw new DocumentParserError(
        "The file does not start with a PDF header, so it is not a PDF."
      );
    }

    return;
  }

  if (!TEXT_UPLOAD_EXTENSIONS.has(normalized)) {
    throw new DocumentParserError(
      "Unsupported document format. Supported formats: .txt, .csv, .md, .json, .log, .tsv, .pdf"
    );
  }

  if (bytes.includes(0)) {
    throw new DocumentParserError(
      "The file contains binary data, so it cannot be read as text."
    );
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentParserError("The file is not valid UTF-8 text.");
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
    if (!TEXT_UPLOAD_EXTENSIONS.has(extension) && extension !== ".pdf") {
      throw new DocumentParserError(
        "Unsupported document format. Supported formats: .txt, .csv, .md, .json, .log, .tsv, .pdf"
      );
    }

    const text = TEXT_UPLOAD_EXTENSIONS.has(extension)
      ? await readTextFile(normalizedPath)
      : await readPdfFile(normalizedPath);

    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      // A PDF that parses but yields no text lands here. It used to answer with
      // the "unsupported format" sentence, which names a different problem and
      // sends the user to the wrong fix.
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
