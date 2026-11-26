import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DocumentParserError, parseDocument } from "./documentParser.service.js";

/**
 * Malformed input is the failure mode that reaches the worker: a file can pass
 * the upload filter by extension, pass the content sniff by its first five bytes,
 * and still be unparseable. These tests pin down what the job records in that
 * case, because the reason is shown to the user and stored on the document.
 */

let directory: string;

async function writeFile(name: string, contents: string | Uint8Array): Promise<string> {
  const target = path.join(directory, name);
  await fs.writeFile(target, contents);

  return target;
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "opspilot-parser-"));
});

after(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("parseDocument failure modes", () => {
  it("reports a PDF that cannot be parsed as a parse failure, not as an unsupported format", async () => {
    // Passes the `%PDF-` sniff and is still not a PDF.
    const target = await writeFile(
      "malformed.pdf",
      "%PDF-1.4\nthis is not a PDF body\n%%EOF"
    );

    const error = await parseDocument(target).then(
      () => null,
      (caught: unknown) => caught
    );

    assert.ok(error instanceof DocumentParserError, `unexpected: ${String(error)}`);
    assert.doesNotMatch(
      error.message,
      /Unsupported document format/,
      "an unparseable PDF is not an unsupported extension"
    );
    assert.match(error.message, /Failed to parse document|extractable text/);
  });

  it("reports an empty file before trying to parse it", async () => {
    const target = await writeFile("empty.pdf", "");

    await assert.rejects(parseDocument(target), {
      name: "DocumentParserError",
      message: "Uploaded file is empty",
    });
  });

  it("reports a file that vanished between queuing and parsing", async () => {
    await assert.rejects(parseDocument(path.join(directory, "gone.md")), {
      name: "DocumentParserError",
      message: "Uploaded file could not be found",
    });
  });

  it("rejects a format it cannot read rather than returning nothing", async () => {
    const target = await writeFile("archive.zip", "PK\u0003\u0004");

    await assert.rejects(parseDocument(target), {
      name: "DocumentParserError",
      message: /Unsupported document format/,
    });
  });

  it("rejects text that is only whitespace", async () => {
    const target = await writeFile("blank.md", "\n\n   \t\n");

    await assert.rejects(parseDocument(target), {
      name: "DocumentParserError",
      message: "Document did not contain extractable text",
    });
  });
});
