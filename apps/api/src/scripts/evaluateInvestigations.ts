import { pool } from "../core/db.js";
import {
  investigationEvaluationCases,
  evaluationDocuments,
  evaluationLogs,
  evaluationTickets,
} from "../evaluation/investigationDataset.js";
import type { InvestigationEvaluationCase } from "../evaluation/investigationDataset.js";
import { hashContent } from "../modules/ingestion/embeddingConfig.js";
import { indexDocument } from "../modules/ingestion/documentIngest.service.js";
import { indexLogEvents } from "../modules/ingestion/logGroup.service.js";
import { indexTicket } from "../modules/ingestion/ticketIngest.service.js";
import {
  collectInvestigationEvidence,
  linkInvestigationEvidence,
} from "../modules/investigations/evidence.service.js";
import {
  createInvestigation,
  getInvestigationDetail,
} from "../modules/investigations/investigation.service.js";
import { getInvestigationTimeline } from "../modules/investigations/timeline.service.js";
import type { InvestigationTimeline } from "../modules/investigations/types.js";

/**
 * Investigation-quality evaluation.
 *
 * Seeds a labelled corpus through the production ingestion path, runs real
 * evidence collection for each case, and measures what an engineer would see:
 * did the expected sources appear, were they graded correctly, were distractors
 * kept out, and was a case with no matching evidence presented honestly?
 *
 * Deterministic by design: no language model is called, so the numbers are stable
 * and can gate CI. Analysis quality is measured separately (it is not repeatable).
 *
 * Run: npm run eval:investigations
 * Keep the corpus for inspection: npm run eval:investigations -- --keep
 * Explain every extra item: npm run eval:investigations -- --breakdown
 */

const ORG_NAME = "Investigation Evaluation (ephemeral)";

const THRESHOLDS = {
  recall: 0.9,
  // Every selected item of the labelled corpus is expected, so the gate sits
  // just below 1: one extra in any of the four positive cases fails CI.
  precision: 0.9,
  gradingAccuracy: 0.85,
} as const;

/** Which rule let a source into the evidence set, read back from its reason. */
type AdmissionCategory =
  | "signature"
  | "similarity"
  | "service"
  | "keyword"
  | "manual"
  | "weak-fallback";

type SelectedDetail = {
  key: string;
  relevance: string;
  expected: boolean;
  matchType: string;
  similarity: number | null;
  retrievalScore: number;
  retrievalQuery: string;
  inclusionReason: string;
  admission: AdmissionCategory;
};

type CaseReport = {
  name: string;
  expected: string[];
  selected: string[];
  /** Every selected source with its grade, for inspection. */
  selectedDetail: SelectedDetail[];
  matched: string[];
  missing: string[];
  unexpected: string[];
  forbiddenHits: string[];
  gradingCorrect: number;
  gradingChecked: number;
  duplicates: number;
  emptyCaseViolations: number;
  /** Manual links, not part of the automatic retrieval metrics. */
  manualLinks: number;
  /** Window-only assertions: bounds, exclusions, timeline labels and ordering. */
  windowFailures: string[];
  windowVerified: boolean;
  warnings: string[];
  latencyMs: number;
};

function keyOf(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

/**
 * Recover which admission rule produced a grade from the stored reason. The
 * reasons are written by `gradeEvidence`, so this stays a reading of the real
 * output rather than a second, parallel model of the rules.
 */
function admissionCategory(
  relevance: string,
  inclusionReason: string
): AdmissionCategory {
  if (/matches the investigation's error signature/.test(inclusionReason)) {
    return "signature";
  }
  if (/cosine similarity/.test(inclusionReason)) {
    return "similarity";
  }
  if (/Belongs to service/.test(inclusionReason)) {
    return "service";
  }
  if (/keywords only/.test(inclusionReason)) {
    return "keyword";
  }
  if (/Linked manually/.test(inclusionReason)) {
    return "manual";
  }
  if (relevance === "weak") {
    return "weak-fallback";
  }
  return "similarity";
}

function emptyReport(name: string): CaseReport {
  return {
    name,
    expected: [],
    selected: [],
    selectedDetail: [],
    matched: [],
    missing: [],
    unexpected: [],
    forbiddenHits: [],
    gradingCorrect: 0,
    gradingChecked: 0,
    duplicates: 0,
    emptyCaseViolations: 0,
    manualLinks: 0,
    windowFailures: [],
    windowVerified: false,
    warnings: [],
    latencyMs: 0,
  };
}

async function ensureOrganization(): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM organizations WHERE name = $1 LIMIT 1`,
    [ORG_NAME]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [ORG_NAME]
  );

  return inserted.rows[0]!.id;
}

async function ensureUser(): Promise<string> {
  const email = "investigation-evaluation@example.com";
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [email]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email, "evaluation"]
  );

  return inserted.rows[0]!.id;
}

async function clearOrganization(organizationId: string): Promise<void> {
  await pool.query(`DELETE FROM investigations WHERE organization_id = $1`, [
    organizationId,
  ]);
  await pool.query(`DELETE FROM documents WHERE organization_id = $1`, [
    organizationId,
  ]);
  await pool.query(`DELETE FROM tickets WHERE organization_id = $1`, [
    organizationId,
  ]);
  await pool.query(`DELETE FROM log_groups WHERE organization_id = $1`, [
    organizationId,
  ]);
  await pool.query(`DELETE FROM logs WHERE organization_id = $1`, [
    organizationId,
  ]);
}

type SeedSourceRef = { sourceType: "document" | "log" | "ticket"; sourceId: string };

async function seedCorpus(
  organizationId: string
): Promise<{
  sourceByKey: Map<string, string>;
  sourceIds: Map<string, SeedSourceRef>;
}> {
  const sourceByKey = new Map<string, string>();
  const sourceIds = new Map<string, SeedSourceRef>();

  for (const document of evaluationDocuments) {
    // The timestamp is computed in SQL: documents.created_at is TIMESTAMP (no
    // time zone) and source_chunks.source_created_at is TIMESTAMPTZ, so a Date
    // written from the client would round-trip through the server time zone and
    // shift the source by that offset.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO documents (organization_id, filename, content, content_hash, created_at)
       VALUES (
         $1, $2, $3, $4,
         CASE WHEN $5::boolean
           THEN NOW() - ($6::int * INTERVAL '1 minute')
           ELSE NULL
         END
       ) RETURNING id`,
      [
        organizationId,
        document.filename,
        document.content,
        hashContent(document.content),
        document.createdMinutesAgo !== null,
        document.createdMinutesAgo ?? 0,
      ]
    );
    const documentId = inserted.rows[0]!.id;
    sourceByKey.set(keyOf("document", documentId), document.key);
    sourceIds.set(document.key, { sourceType: "document", sourceId: documentId });
    await indexDocument({ organizationId, documentId });
  }

  for (const ticket of evaluationTickets) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO tickets (organization_id, title, description, status, priority, created_at)
       VALUES (
         $1, $2, $3, $4, $5,
         CASE WHEN $6::boolean
           THEN NOW() - ($7::int * INTERVAL '1 minute')
           ELSE NULL
         END
       ) RETURNING id`,
      [
        organizationId,
        ticket.title,
        ticket.description,
        ticket.status,
        ticket.priority,
        ticket.createdMinutesAgo !== null,
        ticket.createdMinutesAgo ?? 0,
      ]
    );
    const ticketId = inserted.rows[0]!.id;
    sourceByKey.set(keyOf("ticket", ticketId), ticket.key);
    sourceIds.set(ticket.key, { sourceType: "ticket", sourceId: ticketId });
    await indexTicket({ organizationId, ticketId });
  }

  const logIds: string[] = [];
  for (const log of evaluationLogs) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO logs (organization_id, level, message, metadata, timestamp)
       VALUES ($1, $2, $3, $4::jsonb, NOW() - ($5::int * INTERVAL '1 minute'))
       RETURNING id`,
      [
        organizationId,
        log.level,
        log.message,
        JSON.stringify({ service: log.service }),
        log.minutesAgo,
      ]
    );
    logIds.push(inserted.rows[0]!.id);
  }

  const grouped = await indexLogEvents({ organizationId, logIds });

  if (grouped.groupIds.length > 0) {
    const groups = await pool.query<{
      id: string;
      template: string;
      sample_content: string | null;
    }>(
      `SELECT id, template, sample_content
       FROM log_groups
       WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, grouped.groupIds]
    );

    for (const seed of evaluationLogs) {
      const group = groups.rows.find((row) =>
        `${row.template}\n${row.sample_content ?? ""}`.includes(seed.marker)
      );

      if (!group) {
        throw new Error(`Could not find the log group for ${seed.key}`);
      }

      sourceByKey.set(keyOf("log", group.id), seed.key);
      sourceIds.set(seed.key, { sourceType: "log", sourceId: group.id });
    }
  }

  return { sourceByKey, sourceIds };
}

function evaluateCase(input: {
  testCase: InvestigationEvaluationCase;
  evidence: Array<{
    sourceType: string;
    sourceId: string;
    relevance: string;
    origin: string;
    inclusionReason: string;
    matchType: string;
    similarity: number | null;
    retrievalScore: number;
    retrievalQuery: string;
  }>;
  warnings: string[];
  latencyMs: number;
  sourceByKey: Map<string, string>;
}): CaseReport {
  const report = emptyReport(input.testCase.name);
  const expectedKeys = input.testCase.expected.map((item) => item.key);
  report.expected = expectedKeys;

  // Retrieval quality is measured on what collection chose. A manual link is an
  // explicit act by an engineer, so it is counted separately instead of being
  // reported as a retrieval false positive.
  const automatic = input.evidence.filter((item) => item.origin !== "manual");
  report.manualLinks = input.evidence.length - automatic.length;

  const selectedKeys = automatic.map(
    (item) => input.sourceByKey.get(keyOf(item.sourceType, item.sourceId)) ??
      keyOf(item.sourceType, item.sourceId)
  );
  report.selected = selectedKeys;
  report.selectedDetail = automatic.map((item) => {
    const key =
      input.sourceByKey.get(keyOf(item.sourceType, item.sourceId)) ??
      keyOf(item.sourceType, item.sourceId);

    return {
      key,
      relevance: item.relevance,
      expected: expectedKeys.includes(key),
      matchType: item.matchType,
      similarity: item.similarity,
      retrievalScore: item.retrievalScore,
      retrievalQuery: item.retrievalQuery,
      inclusionReason: item.inclusionReason,
      admission: admissionCategory(item.relevance, item.inclusionReason),
    };
  });
  report.warnings = input.warnings;
  report.latencyMs = input.latencyMs;
  report.duplicates =
    selectedKeys.length - new Set(selectedKeys).size;

  for (const selected of selectedKeys) {
    if (!expectedKeys.includes(selected)) {
      report.unexpected.push(selected);
    }
  }

  report.forbiddenHits = selectedKeys.filter((key) =>
    input.testCase.forbidden.includes(key)
  );

  for (const item of automatic) {
    const key =
      input.sourceByKey.get(keyOf(item.sourceType, item.sourceId)) ??
      keyOf(item.sourceType, item.sourceId);
    const expectation = input.testCase.expected.find(
      (entry) => entry.key === key
    );

    if (expectation) {
      report.matched.push(key);
      report.gradingChecked += 1;
      if (
        expectation.allowedRelevance.includes(
          item.relevance as "direct" | "historical" | "related" | "weak"
        )
      ) {
        report.gradingCorrect += 1;
      }
    } else if (input.testCase.expectEmpty === true) {
      report.emptyCaseViolations += 1;
    }
  }

  report.missing = expectedKeys.filter((key) => !report.matched.includes(key));

  return report;
}

/**
 * Assertions that only a windowed case can make: the bounds are honoured, the
 * excluded sources stay out, the timeline labels each source against the window,
 * and the timeline is ordered by time.
 */
function checkWindow(input: {
  testCase: InvestigationEvaluationCase;
  evidence: Array<{
    id: string;
    sourceType: string;
    sourceId: string;
    sourceCreatedAt: string | null;
    origin: string;
  }>;
  timeline: InvestigationTimeline;
  bounds: { start: string; end: string };
  sourceByKey: Map<string, string>;
}): string[] {
  const window = input.testCase.window;
  if (!window) {
    return [];
  }

  const failures: string[] = [];
  const start = new Date(input.bounds.start).getTime();
  const end = new Date(input.bounds.end).getTime();
  const keyFor = (sourceType: string, sourceId: string): string =>
    input.sourceByKey.get(keyOf(sourceType, sourceId)) ??
    keyOf(sourceType, sourceId);

  const byKey = new Map(
    input.evidence.map((item) => [keyFor(item.sourceType, item.sourceId), item])
  );
  const eventFor = (evidenceId: string | null) =>
    evidenceId === null
      ? undefined
      : input.timeline.events.find((event) => event.evidenceId === evidenceId);

  for (const key of window.inWindow) {
    const item = byKey.get(key);
    if (!item) {
      failures.push(`${key} is inside the window but was not collected`);
      continue;
    }
    if (item.sourceCreatedAt === null) {
      failures.push(`${key} was collected without a source timestamp`);
      continue;
    }
    const at = new Date(item.sourceCreatedAt).getTime();
    if (at < start || at > end) {
      failures.push(
        `${key} was collected with sourceCreatedAt ${item.sourceCreatedAt}, outside ${input.bounds.start} → ${input.bounds.end}`
      );
    }
  }

  for (const key of [...window.beforeWindow, ...window.afterWindow]) {
    const item = byKey.get(key);
    if (item && item.origin === "retrieval") {
      failures.push(`${key} lies outside the window but was auto-collected`);
    }
  }

  for (const key of window.undated) {
    if (byKey.has(key)) {
      failures.push(`${key} has no timestamp but was collected`);
    }
  }

  const manual = byKey.get(window.manualLink);
  if (!manual) {
    failures.push(`manual link of ${window.manualLink} did not add evidence`);
  } else {
    const event = eventFor(manual.id);
    if (!event) {
      failures.push(`no timeline event for manually linked ${window.manualLink}`);
    } else if (!event.correlations.includes("before_window")) {
      failures.push(
        `${window.manualLink} is labelled [${event.correlations.join(
          ", "
        )}] instead of before_window`
      );
    }
  }

  for (const key of window.inWindow) {
    const item = byKey.get(key);
    if (!item) {
      continue;
    }
    const event = eventFor(item.id);
    if (!event) {
      failures.push(`no timeline event for in-window ${key}`);
      continue;
    }
    if (!event.correlations.includes("in_window")) {
      failures.push(
        `${key} is labelled [${event.correlations.join(
          ", "
        )}] instead of in_window`
      );
    }
    if (!event.atSourceTime) {
      failures.push(`${key} timeline event does not use the source timestamp`);
    }
  }

  for (let index = 1; index < input.timeline.events.length; index += 1) {
    const previous = input.timeline.events[index - 1]!;
    const current = input.timeline.events[index]!;
    if (new Date(current.at).getTime() < new Date(previous.at).getTime()) {
      failures.push(
        `timeline is not ordered: ${current.at} follows ${previous.at}`
      );
      break;
    }
  }

  return failures;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const breakdown = process.argv.includes("--breakdown");
  const organizationId = await ensureOrganization();
  const userId = await ensureUser();

  if (!keep) {
    await clearOrganization(organizationId);
  }

  console.log(`Seeding corpus into organisation ${organizationId}…`);
  const { sourceByKey, sourceIds } = await seedCorpus(organizationId);

  const reports: CaseReport[] = [];

  for (const testCase of investigationEvaluationCases) {
    const windowBounds = testCase.window
      ? {
          start: new Date(
            Date.now() - testCase.window.startMinutesAgo * 60_000
          ).toISOString(),
          end: new Date(
            Date.now() - testCase.window.endMinutesAgo * 60_000
          ).toISOString(),
        }
      : undefined;

    const created = await createInvestigation({
      organizationId,
      userId,
      payload: {
        ...testCase.investigation,
        ...(windowBounds
          ? { windowStart: windowBounds.start, windowEnd: windowBounds.end }
          : {}),
      },
    });
    const investigationId = created.detail.investigation.id;

    const startedAt = Date.now();
    const collection = await collectInvestigationEvidence({
      organizationId,
      investigationId,
      userId,
    });
    const latencyMs = Date.now() - startedAt;

    let detail = await getInvestigationDetail(organizationId, investigationId);
    const windowFailures: string[] = [];

    if (testCase.window && windowBounds) {
      const manual = sourceIds.get(testCase.window.manualLink);
      if (!manual) {
        windowFailures.push(`seed source ${testCase.window.manualLink} was not seeded`);
      } else {
        const linked = await linkInvestigationEvidence({
          organizationId,
          investigationId,
          userId,
          payload: {
            sourceType: manual.sourceType,
            sourceId: manual.sourceId,
            reason:
              "Same failure occurred before the investigation window; linked deliberately.",
          },
        });
        if (!linked.added) {
          windowFailures.push(
            `manual link of ${testCase.window.manualLink} added nothing`
          );
        }
        detail = await getInvestigationDetail(organizationId, investigationId);
      }

      const timeline = await getInvestigationTimeline(
        organizationId,
        investigationId
      );

      windowFailures.push(
        ...checkWindow({
          testCase,
          evidence: detail.evidence,
          timeline,
          bounds: windowBounds,
          sourceByKey,
        })
      );
    }

    const report = evaluateCase({
      testCase,
      evidence: detail.evidence,
      warnings: collection.summary.warnings,
      latencyMs,
      sourceByKey,
    });
    report.windowFailures = windowFailures;
    report.windowVerified = testCase.window !== undefined && windowFailures.length === 0;
    reports.push(report);
  }

  const positive = reports.filter((report) => report.expected.length > 0);

  const recalls = positive.map(
    (report) => report.matched.length / report.expected.length
  );
  const precisions = positive.map((report) =>
    report.selected.length === 0
      ? 0
      : report.matched.length / report.selected.length
  );
  const gradingAccuracy =
    reports.reduce((sum, report) => sum + report.gradingCorrect, 0) /
    Math.max(
      1,
      reports.reduce((sum, report) => sum + report.gradingChecked, 0)
    );

  console.log("\nPer case");
  console.log(
    [
      "case".padEnd(22),
      "recall".padStart(7),
      "prec".padStart(6),
      "grade".padStart(6),
      "found".padStart(7),
      "ms".padStart(6),
    ].join(" ")
  );

  for (const report of reports) {
    const recall =
      report.expected.length === 0
        ? null
        : report.matched.length / report.expected.length;
    const precision =
      report.expected.length === 0 || report.selected.length === 0
        ? null
        : report.matched.length / report.selected.length;

    console.log(
      [
        report.name.padEnd(22),
        (recall === null ? "-" : percent(recall)).padStart(7),
        (precision === null ? "-" : percent(precision)).padStart(6),
        (report.gradingChecked === 0
          ? "-"
          : percent(report.gradingCorrect / report.gradingChecked)
        ).padStart(6),
        `${report.matched.length}/${report.expected.length}`.padStart(7),
        String(report.latencyMs).padStart(6),
      ].join(" ")
    );

    for (const item of report.selectedDetail) {
      const marker = item.expected ? "found" : "extra";

      if (!breakdown) {
        console.log(`  ${marker}  ${item.key} [${item.relevance}]`);
        continue;
      }

      console.log(
        `  ${marker}  ${item.key} [${item.relevance}] ` +
          `admission=${item.admission} match=${item.matchType} ` +
          `sim=${item.similarity === null ? "-" : item.similarity.toFixed(2)} ` +
          `score=${item.retrievalScore.toFixed(3)} ` +
          `query="${item.retrievalQuery}"`
      );
      if (!item.expected) {
        console.log(`          reason: ${item.inclusionReason}`);
      }
    }
    if (report.missing.length > 0) {
      console.log(`  missing: ${report.missing.join(", ")}`);
    }
    if (report.forbiddenHits.length > 0) {
      console.log(`  FORBIDDEN: ${report.forbiddenHits.join(", ")}`);
    }
    const wrongGrades = report.gradingChecked - report.gradingCorrect;
    if (wrongGrades > 0) {
      console.log(`  misgraded: ${wrongGrades}/${report.gradingChecked}`);
    }
    if (report.emptyCaseViolations > 0) {
      console.log(
        `  expect-empty violated: ${report.selectedDetail
          .map((item) => `${item.key} [${item.relevance}]`)
          .join(", ")}`
      );
    }
    if (report.windowFailures.length > 0) {
      for (const failure of report.windowFailures) {
        console.log(`  WINDOW: ${failure}`);
      }
    } else if (report.windowVerified) {
      console.log(
        "  window: PASS (bounds, exclusions, undated source, manual link, timeline labels and order)"
      );
    }
    if (report.manualLinks > 0) {
      console.log(
        `  manual: ${report.manualLinks} source(s) linked by hand (not counted as retrieval)`
      );
    }
    if (report.warnings.length > 0) {
      console.log(`  warnings: ${report.warnings.join(" | ")}`);
    }
  }

  const duplicateViolations = reports.reduce(
    (sum, report) => sum + report.duplicates,
    0
  );
  const forbiddenHits = reports.reduce(
    (sum, report) => sum + report.forbiddenHits.length,
    0
  );
  const emptyCaseViolations = reports.reduce(
    (sum, report) => sum + report.emptyCaseViolations,
    0
  );
  const windowFailures = reports.reduce(
    (sum, report) => sum + report.windowFailures.length,
    0
  );
  const extras = reports.flatMap((report) =>
    report.selectedDetail.filter((item) => !item.expected)
  );
  const totalSelected = reports.reduce(
    (sum, report) => sum + report.selected.length,
    0
  );

  const aggregate = {
    cases: reports.length,
    positiveCases: positive.length,
    recall: mean(recalls),
    precision: mean(precisions),
    gradingAccuracy,
    selected: totalSelected,
    extras: extras.length,
    duplicateViolations,
    forbiddenHits,
    emptyCaseViolations,
    manualLinks: reports.reduce((sum, report) => sum + report.manualLinks, 0),
    windowFailures,
    meanLatencyMs: Math.round(mean(reports.map((report) => report.latencyMs))),
  };

  console.log("\nAggregate");
  console.log(
    JSON.stringify(
      {
        ...aggregate,
        recall: Number(aggregate.recall.toFixed(3)),
        precision: Number(aggregate.precision.toFixed(3)),
        gradingAccuracy: Number(aggregate.gradingAccuracy.toFixed(3)),
      },
      null,
      2
    )
  );

  if (breakdown) {
    const countBy = (values: string[]): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
      }
      return counts;
    };

    console.log("\nFalse-positive diagnosis (--breakdown)");
    console.log(
      `  extras: ${extras.length} of ${totalSelected} selected item(s)`
    );
    console.log(
      `  by admission rule: ${JSON.stringify(
        countBy(extras.map((item) => item.admission))
      )}`
    );
    console.log(
      `  by grade: ${JSON.stringify(
        countBy(extras.map((item) => item.relevance))
      )}`
    );
    console.log(
      `  by source type: ${JSON.stringify(
        countBy(extras.map((item) => item.key.split(":")[0] ?? "unknown"))
      )}`
    );
  }

  const failures: string[] = [];
  if (aggregate.recall < THRESHOLDS.recall) {
    failures.push(
      `recall ${percent(aggregate.recall)} < ${percent(THRESHOLDS.recall)}`
    );
  }
  if (aggregate.precision < THRESHOLDS.precision) {
    failures.push(
      `precision ${percent(aggregate.precision)} < ${percent(
        THRESHOLDS.precision
      )}`
    );
  }
  if (aggregate.gradingAccuracy < THRESHOLDS.gradingAccuracy) {
    failures.push(
      `grading ${percent(aggregate.gradingAccuracy)} < ${percent(
        THRESHOLDS.gradingAccuracy
      )}`
    );
  }
  if (duplicateViolations > 0) {
    failures.push(`${duplicateViolations} duplicate source(s) selected`);
  }
  if (forbiddenHits > 0) {
    failures.push(`${forbiddenHits} forbidden source(s) selected`);
  }
  if (emptyCaseViolations > 0) {
    failures.push(
      `${emptyCaseViolations} item(s) collected for a case whose honest answer is "no matching evidence"`
    );
  }
  if (windowFailures > 0) {
    failures.push(`${windowFailures} time-window check(s) failed`);
  }

  console.log(
    failures.length === 0
      ? "\nThresholds: PASS"
      : `\nThresholds: FAIL — ${failures.join("; ")}`
  );

  if (!keep) {
    await clearOrganization(organizationId);
    console.log("Corpus removed (pass --keep to inspect it).");
  } else {
    console.log("Corpus kept for inspection.");
  }

  await pool.end();
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error("Investigation evaluation failed", error);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
