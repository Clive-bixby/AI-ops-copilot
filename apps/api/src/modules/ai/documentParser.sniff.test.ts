import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertContentMatchesExtension,
  DocumentParserError,
} from "./documentParser.service.js";

/**
 * Uploads are filtered on the filename alone, so the bytes are the only thing
 * that can tell a real runbook from a renamed binary. These cases pin the
 * checks the upload path applies before anything is queued for parsing.
 */

describe("assertContentMatchesExtension", () => {
  it("accepts a PDF that starts with the PDF header", () => {
    const bytes = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n", "latin1");

    assert.doesNotThrow(() => assertContentMatchesExtension(".pdf", bytes));
  });

  it("rejects a text file renamed to .pdf", () => {
    assert.throws(
      () =>
        assertContentMatchesExtension(
          ".pdf",
          Buffer.from("this is just a markdown file", "utf8")
        ),
      DocumentParserError
    );
  });

  it("accepts UTF-8 text for every text extension", () => {
    const bytes = Buffer.from("Résumé of the rollback — step 1.\n", "utf8");

    for (const extension of [".txt", ".csv", ".md", ".json", ".log", ".tsv"]) {
      assert.doesNotThrow(() => assertContentMatchesExtension(extension, bytes));
    }
  });

  it("rejects binary content hidden behind a text extension", () => {
    const bytes = Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03]);

    assert.throws(
      () => assertContentMatchesExtension(".log", bytes),
      DocumentParserError
    );
  });

  it("rejects bytes that are not valid UTF-8", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x42]);

    assert.throws(
      () => assertContentMatchesExtension(".txt", bytes),
      DocumentParserError
    );
  });

  it("rejects an extension the upload filter should already have blocked", () => {
    assert.throws(
      () => assertContentMatchesExtension(".exe", Buffer.from("MZ", "utf8")),
      DocumentParserError
    );
  });
});
