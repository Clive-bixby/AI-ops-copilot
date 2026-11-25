import "../config/env.js";

import fs from "node:fs/promises";
import path from "node:path";

import {
  llmEvaluationCases,
  type LlmCase,
  type LlmEvidence,
} from "../evaluation/llmDataset.js";
import {
  aggregateScores,
  numbersInText,
  scoreCase,
  type CaseDefinition,
  type ScoredCase,
} from "../evaluation/llmScoring.js";
import {
  buildAnalysisPrompt,
  type AnalysisEvidence,
  type AnalysisInvestigation,
} from "../modules/investigations/analysisPolicy.js";
import { buildFollowUpPrompt } from "../modules/investigations/followUpPolicy.js";
import {
  buildEvaluationPrompt,
  classifyQuery,
  type PromptContextChunk,
} from "../modules/ai/rag.service.js";
import { getLlmProvider } from "../modules/ai/llm/index.js";
import type { LlmResponseFormat, LlmResult } from "../modules/ai/llm/provider.js";

/**
 * Offline generation evaluation.
 *
 * Two modes, because they answer different questions:
 *
 *   --record   ask the configured provider and cache every raw response. Costs
 *              money and quota, and is the only way to see a model's real output.
 *   --replay   score the cached responses with no network at all. Deterministic,
 *              free, and safe in CI.
 *
 * Scoring never calls a model: it reuses the production parsers and counts facts,
 * citations, invented numbers and refusals. See src/evaluation/llmScoring.ts.
 *
 * Usage:
 *   npm run eval:llm -- --list
 *   npm run eval:llm -- --record [--out .eval/llm-runs/<label>] [--case <id>]
 *                          [--limit <n>] [--delay <ms>] [--resume]
 *   npm run eval:llm -- --replay .eval/llm-runs/<label> [--json] [--report-only]
 *
 * `--delay` paces the calls to stay inside a free-tier requests-per-minute limit,
 * `--limit` keeps a single sweep inside a requests-per-day limit (Gemini's free
 * tier allows 20 per model per day, and the dataset has 24 cases), and `--resume`
 * keeps whatever a rate-limited run already recorded: a sweep that dies at case 18
 * should continue from 19 the next day, not spend its quota on 1..17 again.
 */

type RecordedCase = {
  caseId: string;
  kind: string;
  provider: string;
  model: string;
  text: string;
  generationMs: number;
  attempts: number;
  usedFallback: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null };
  promptChars: number;
  recordedAt: string;
};

type Prepared = {
  testCase: LlmCase;
  prompt: string;
  evidenceIds: string[];
  responseFormat: LlmResponseFormat;
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const options = {
    list: false,
    record: false,
    replay: null as string | null,
    out: null as string | null,
    only: null as string | null,
    json: false,
    reportOnly: false,
    delay: 0,
    resume: false,
    limit: null as number | null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--list":
        options.list = true;
        break;
      case "--record":
        options.record = true;
        break;
      case "--replay":
        options.replay = argv[(index += 1)] ?? fail("--replay needs a directory");
        break;
      case "--out":
        options.out = argv[(index += 1)] ?? fail("--out needs a directory");
        break;
      case "--case":
        options.only = argv[(index += 1)] ?? fail("--case needs an id");
        break;
      case "--json":
        options.json = true;
        break;
      case "--report-only":
        options.reportOnly = true;
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--limit": {
        const raw = argv[(index += 1)] ?? fail("--limit needs a number of cases");
        const parsed = Number(raw);

        if (!Number.isInteger(parsed) || parsed < 1) {
          fail("--limit needs a positive whole number of cases");
        }

        options.limit = parsed;
        break;
      }
      case "--delay": {
        const raw = argv[(index += 1)] ?? fail("--delay needs a number of milliseconds");
        const parsed = Number(raw);

        if (!Number.isFinite(parsed) || parsed < 0) {
          fail("--delay needs a non-negative number of milliseconds");
        }

        options.delay = parsed;
        break;
      }
      default:
        fail(`Unknown argument "${arg}". Try --list, --record or --replay <dir>.`);
    }
  }

  return options;
}

/* ------------------------------------------------------------------ prompts */

function toAnalysisEvidence(evidence: LlmEvidence): AnalysisEvidence {
  return {
    // The label doubles as the id so the parser resolves "E1" to "E1": a dropped
    // citation then means exactly "the model cited a label that was never sent".
    id: evidence.label,
    sourceType: evidence.sourceType,
    sourceTitle: evidence.title,
    excerpt: evidence.excerpt,
    relevance: evidence.relevance,
    sourceCreatedAt: evidence.createdAt,
  };
}

function toInvestigation(testCase: LlmCase): AnalysisInvestigation {
  return {
    id: testCase.id,
    title: testCase.investigation.title,
    description: testCase.investigation.description,
    severity: testCase.investigation.severity,
    service: testCase.investigation.service,
    errorSignature: testCase.investigation.errorSignature,
    windowStart: null,
    windowEnd: null,
  };
}

function toContextChunk(evidence: LlmEvidence, index: number): PromptContextChunk {
  return {
    sourceType: evidence.sourceType,
    sourceId: evidence.label,
    documentId: null,
    matchType: "vector",
    chunkIndex: index,
    // A fixed similarity: the harness is scoring generation, not ranking, and a
    // real score here would only change how the prompt prints it.
    similarity: 0.9,
    preview: evidence.title,
    content: evidence.excerpt,
    sourceNumber: index + 1,
    promptContent: `${evidence.title}\n${evidence.excerpt}`,
  };
}

function prepare(testCase: LlmCase): Prepared {
  if (testCase.kind === "grounded_answer") {
    const question = testCase.question;

    if (question === undefined) {
      throw new Error(`${testCase.id}: a grounded_answer case needs a question`);
    }

    const context = testCase.evidence.map(toContextChunk);

    return {
      testCase,
      prompt: buildEvaluationPrompt({
        question,
        queryType: classifyQuery(question),
        context,
      }),
      evidenceIds: testCase.evidence.map((evidence) => evidence.label),
      responseFormat: "text",
    };
  }

  const investigation = toInvestigation(testCase);
  const evidence = testCase.evidence.map(toAnalysisEvidence);

  if (testCase.kind === "follow_up") {
    const question = testCase.question;

    if (question === undefined) {
      throw new Error(`${testCase.id}: a follow_up case needs a question`);
    }

    const built = buildFollowUpPrompt({
      investigation,
      question,
      evidence,
      analysis: null,
    });

    return { testCase, prompt: built.prompt, evidenceIds: built.evidenceIds, responseFormat: "json" };
  }

  const built = buildAnalysisPrompt({ investigation, evidence });

  return { testCase, prompt: built.prompt, evidenceIds: built.evidenceIds, responseFormat: "json" };
}

/* ------------------------------------------------------------------- record */

async function record(prepared: Prepared, outDir: string): Promise<RecordedCase> {
  const feature = prepared.testCase.kind === "grounded_answer" ? "rag" : "analysis";
  const provider = getLlmProvider(feature);

  const result: LlmResult = await provider.generate({
    prompt: prepared.prompt,
    responseFormat: prepared.responseFormat,
    // Deterministic as far as the provider allows: a harness that samples is a
    // harness whose score moves on its own.
    temperature: 0,
    maxOutputTokens: prepared.responseFormat === "text" ? 1_200 : 2_000,
  });

  const recorded: RecordedCase = {
    caseId: prepared.testCase.id,
    kind: prepared.testCase.kind,
    provider: result.provider,
    model: result.model,
    text: result.text,
    generationMs: result.generationMs,
    attempts: result.attempts,
    usedFallback: result.usedFallback,
    usage: result.usage,
    promptChars: prepared.prompt.length,
    recordedAt: new Date().toISOString(),
  };

  await fs.writeFile(
    path.join(outDir, `${prepared.testCase.id}.json`),
    `${JSON.stringify(recorded, null, 2)}\n`,
    "utf8"
  );

  return recorded;
}

/**
 * Every number the model was legitimately shown is fair game; anything else it
 * produced. That set is wider than the evidence excerpts: the prompt also prints
 * each source's timestamp, the investigation's own description (which may name a
 * status code) and the question. Counting all of it keeps the dataset honest as
 * excerpts change, without flagging the model for repeating its instructions.
 *
 * ISO timestamps are split into components, because a prompt that says
 * "2026-11-24T09:41:00Z" has told the model about 09:41: an answer quoting
 * "09:41" is recalling, not inventing.
 */
function numbersShownToModel(prepared: Prepared): string[] {
  const { testCase } = prepared;
  const shown = [
    ...testCase.evidence.map(
      (evidence) => `${evidence.title} ${evidence.excerpt} ${evidence.createdAt ?? ""}`
    ),
    `${testCase.investigation.title} ${testCase.investigation.description} ${testCase.investigation.errorSignature}`,
    testCase.question ?? "",
  ];

  return numbersInText(shown.join(" ").replace(/[-:T]/g, " "));
}

function effectiveCase(prepared: Prepared): CaseDefinition {
  return {
    ...prepared.testCase,
    allowedNumbers: [
      ...new Set([...prepared.testCase.allowedNumbers, ...numbersShownToModel(prepared)]),
    ],
  };
}

/* ------------------------------------------------------------------ reports */

function percent(value: number): string {
  return value.toFixed(3);
}

function printCaseRow(score: ScoredCase): void {
  const flags = [
    score.parsed ? "" : "unparsed",
    score.hallucinated ? "HALLUCINATED" : "",
    ...score.constraintViolations,
  ].filter(Boolean);

  console.log(
    [
      score.id.padEnd(34),
      score.kind.padEnd(15),
      `facts ${score.factsFound}/${score.factsTotal}`.padEnd(12),
      `cit ${percent(score.citationPrecision)}`.padEnd(12),
      flags.length === 0 ? "ok" : flags.join("; "),
    ].join(" ")
  );
}

async function writeReview(
  outDir: string,
  prepared: Prepared[],
  scores: ScoredCase[],
  recordings: RecordedCase[]
): Promise<string> {
  const byId = new Map(recordings.map((recorded) => [recorded.caseId, recorded]));
  const lines = [
    "# LLM evaluation run",
    "",
    `Generated ${new Date().toISOString()} from ${prepared.length} cases.`,
    "",
    "Scoring is deterministic (see `src/evaluation/llmScoring.ts`); this file is for",
    "the judgement a scorer cannot make -- is the answer actually the right one?",
    "",
  ];

  for (const [index, item] of prepared.entries()) {
    const recorded = byId.get(item.testCase.id);
    const score = scores[index]!;

    lines.push(
      `## ${item.testCase.id} -- ${item.testCase.scenario}`,
      "",
      `- kind: ${item.testCase.kind}`,
      `- provider: ${recorded?.provider ?? "unknown"} (${recorded?.model ?? "unknown"})`,
      `- latency: ${recorded?.generationMs ?? 0} ms`,
      `- facts: ${score.factsFound}/${score.factsTotal}`,
      `- citation precision: ${percent(score.citationPrecision)}`,
      `- hallucinated: ${score.hallucinated ? "yes" : "no"}`,
      score.forbiddenHits.length > 0
        ? `- forbidden entities named: ${score.forbiddenHits.join(", ")}`
        : "",
      score.inventedNumbers.length > 0
        ? `- numbers not in evidence: ${score.inventedNumbers.join(", ")}`
        : "",
      score.constraintViolations.length > 0
        ? `- violations: ${score.constraintViolations.join("; ")}`
        : "",
      "",
      "<details><summary>Prompt</summary>",
      "",
      "```text",
      item.prompt,
      "```",
      "",
      "</details>",
      "",
      "Response:",
      "",
      "```text",
      recorded?.text ?? "(missing)",
      "```",
      "",
      "- [ ] reads as the correct operational answer",
      "- [ ] every claim is traceable to the evidence above",
      ""
    );
  }

  const file = path.join(outDir, "review.md");
  await fs.writeFile(file, lines.filter((line) => line !== undefined).join("\n"), "utf8");

  return file;
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    for (const testCase of llmEvaluationCases) {
      console.log(
        `${testCase.id.padEnd(34)} ${testCase.kind.padEnd(15)} ${testCase.scenario}`
      );
    }

    return 0;
  }

  if (!options.record && options.replay === null) {
    fail("Choose --record, --replay <dir> or --list.");
  }

  const matched =
    options.only === null
      ? llmEvaluationCases
      : llmEvaluationCases.filter((testCase) => testCase.id === options.only);
  const selected = options.limit === null ? matched : matched.slice(0, options.limit);

  if (selected.length === 0) {
    fail(`No case matches "${options.only}". Run --list to see the ids.`);
  }

  const prepared = selected.map(prepare);
  let outDir =
    options.out ??
    path.join(".eval", "llm-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  if (options.replay !== null) outDir = options.replay;
  if (options.record) await fs.mkdir(outDir, { recursive: true });

  const recordings: RecordedCase[] = [];

  for (const item of prepared) {
    if (options.record) {
      if (options.resume) {
        try {
          const cached = JSON.parse(
            await fs.readFile(path.join(outDir, `${item.testCase.id}.json`), "utf8")
          ) as RecordedCase;
          recordings.push(cached);
          console.log(`cached    ${item.testCase.id} (${cached.model})`);
          continue;
        } catch {
          // Not recorded yet: fall through and ask the provider.
        }
      }

      process.stdout.write(`recording ${item.testCase.id} ... `);
      try {
        const recorded = await record(item, outDir);
        recordings.push(recorded);
        console.log(`${recorded.provider}/${recorded.model} ${recorded.generationMs}ms`);
      } catch (error) {
        // A provider outage is not a score. Stop rather than record a failure as
        // if it were the model's output. With --resume, the next run continues
        // from here instead of paying for the same calls again.
        console.log("failed");
        throw error;
      }

      if (options.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      }

      continue;
    }

    const file = path.join(outDir, `${item.testCase.id}.json`);
    let raw: string;

    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      fail(
        `Missing recorded response ${file}. Replay refuses a partial run: a missing\n` +
          "case would quietly disappear from the aggregate."
      );
    }

    recordings.push(JSON.parse(raw) as RecordedCase);
  }

  const scores = prepared.map((item, index) =>
    scoreCase({
      testCase: effectiveCase(item),
      raw: recordings[index]!.text,
      evidenceIds: item.evidenceIds,
      // The production path applies this rule after parsing, so a replay that
      // omitted the grading would score the parser alone.
      evidenceRelevance: item.testCase.evidence.map((entry) => entry.relevance),
    })
  );

  console.log("");
  for (const score of scores) printCaseRow(score);

  const aggregate = aggregateScores(scores);
  const latencies = recordings.map((recorded) => recorded.generationMs).sort((a, b) => a - b);
  const p95 = latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!;
  const meanLatency =
    latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const inputTokens = recordings.reduce((sum, recorded) => sum + (recorded.usage.inputTokens ?? 0), 0);
  const outputTokens = recordings.reduce((sum, recorded) => sum + (recorded.usage.outputTokens ?? 0), 0);
  const identities = [
    ...new Set(recordings.map((recorded) => `${recorded.provider}/${recorded.model}`)),
  ];

  console.log("");
  console.log(
    `cases ${aggregate.cases} | parsed ${percent(aggregate.parsedRate)} | schema ${percent(
      aggregate.schemaRate
    )} | facts ${percent(aggregate.factCoverage)} | citations ${percent(
      aggregate.citationPrecision
    )}`
  );
  console.log(
    `hallucination ${percent(aggregate.hallucinationRate)} | refusal ${
      aggregate.refusalAccuracy === null ? "n/a" : percent(aggregate.refusalAccuracy)
    } | constraints ${percent(aggregate.constraintRate)}`
  );
  console.log(
    `dropped citations ${aggregate.totalDroppedCitations} | forbidden hits ${
      aggregate.totalForbiddenHits
    } | invented numbers ${aggregate.totalInventedNumbers}`
  );
  console.log(
    `latency mean ${Math.round(meanLatency)}ms p95 ${p95}ms | tokens in ${inputTokens} out ${outputTokens} | ${
      identities.join(", ") || "no provider"
    }`
  );

  if (options.record) {
    const review = await writeReview(outDir, prepared, scores, recordings);
    console.log(`review written to ${review}`);
  }

  if (options.json) {
    console.log(
      `EVAL_LLM_JSON=${JSON.stringify({ aggregate, cases: scores, identities })}`
    );
  }

  if (!options.reportOnly) {
    const failures = scores.filter((score) => !score.parsed || score.hallucinated);

    if (failures.length > 0) {
      console.log(`FAIL ${failures.length} case(s) need attention.`);
      return 1;
    }
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
