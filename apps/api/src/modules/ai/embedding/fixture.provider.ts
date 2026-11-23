import { createHash } from "node:crypto";
import fs from "node:fs";

import { EmbeddingModelError } from "./errors.js";
import type { EmbeddingBatch, EmbeddingProbe, EmbeddingProvider } from "./provider.js";
import type { EmbeddingSettings } from "./settings.js";

type Fixture = {
  model: string;
  dimensions: number;
  /** sha256 of the normalised text → recorded vector. */
  vectors: Record<string, number[]>;
};

/**
 * Log-group chunks embed their absolute window start and end, so the same log
 * template would hash differently on every run. Timestamps are blanked before
 * hashing: they carry no meaning for similarity, while the template, level,
 * service and sample events still identify the text.
 *
 * This must stay identical to the recorder in
 * `scripts/embeddingFixtureServer.ts`, or a recorded vector will never be found.
 */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

export function fixtureKeyOf(text: string): string {
  return createHash("sha256")
    .update(text.trim().replace(ISO_TIMESTAMP, "<timestamp>"))
    .digest("hex");
}

/**
 * Replays vectors recorded from a real model, with no embedding service at all.
 *
 * This is what lets a $0 deployment demonstrate retrieval: the seeded corpus is
 * indexed with the same vectors a model produced, so search and citations are
 * real. Text that was never recorded is a hard error rather than a placeholder
 * vector -- an invented embedding would make the demo look correct while
 * measuring nothing.
 *
 * The file is read when the provider is created, and the model it reports comes
 * from the file so `embedding_model` on every chunk stays truthful.
 */
export class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fixture" as const;
  readonly endpoint: string;
  readonly dimensions: number;
  readonly model: string;

  private readonly fixture: Fixture | null;
  private readonly loadError: string | null;

  constructor(settings: EmbeddingSettings) {
    this.endpoint = settings.fixturePath;
    this.dimensions = settings.dimensions;
    this.model = settings.model;
    this.fixture = null;
    this.loadError = null;

    try {
      if (!fs.existsSync(settings.fixturePath)) {
        this.loadError =
          `The embedding fixture file was not found at ${settings.fixturePath}. ` +
          "Record it with `UPSTREAM_OLLAMA_URL=... npx tsx src/scripts/embeddingFixtureServer.ts --record` " +
          "or set EMBEDDING_FIXTURE_PATH.";
        return;
      }

      const parsed = JSON.parse(
        fs.readFileSync(settings.fixturePath, "utf8")
      ) as Fixture;

      if (!parsed.vectors || typeof parsed.vectors !== "object") {
        this.loadError = `The embedding fixture at ${settings.fixturePath} has no "vectors" map.`;
        return;
      }

      if (parsed.dimensions !== settings.dimensions) {
        this.loadError =
          `The embedding fixture stores ${parsed.dimensions}-dimension vectors but ` +
          `${settings.dimensions} is configured. Re-record the fixture or fix EMBEDDING_DIMENSIONS.`;
        return;
      }

      this.fixture = parsed;
      this.model = parsed.model || settings.model;
    } catch (error) {
      this.loadError = `The embedding fixture at ${settings.fixturePath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  private requireFixture(): Fixture {
    if (this.loadError !== null || this.fixture === null) {
      throw new EmbeddingModelError(
        this.loadError ?? "The embedding fixture is unavailable."
      );
    }

    return this.fixture;
  }

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    const fixture = this.requireFixture();

    const embeddings = texts.map((text) => {
      const record = fixture.vectors[fixtureKeyOf(text)];

      if (!record) {
        throw new EmbeddingModelError(
          "This deployment replays recorded embeddings, and this text has not been " +
            `recorded (${Object.keys(fixture.vectors).length} texts are available). ` +
            "Only the seeded demo corpus can be embedded in fixture mode; configure " +
            "EMBEDDING_PROVIDER=openai-compatible or ollama to ingest new content."
        );
      }

      return record;
    });

    return { embeddings, model: fixture.model };
  }

  async probe(): Promise<EmbeddingProbe> {
    if (this.loadError !== null || this.fixture === null) {
      return { ok: false, message: this.loadError ?? "The embedding fixture is unavailable" };
    }

    const count = Object.keys(this.fixture.vectors).length;

    return {
      ok: count > 0,
      message:
        count > 0
          ? `${count} recorded vectors for ${this.fixture.model} (${this.fixture.dimensions}d)`
          : `The embedding fixture at ${this.endpoint} contains no vectors`,
    };
  }
}
