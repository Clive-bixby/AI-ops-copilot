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
import { collectInvestigationEvidence } from "../modules/investigations/evidence.service.js";
import {
  createInvestigation,
  getInvestigationDetail,
} from "../modules/investigations/investigation.service.js";

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
 */

const ORG_NAME = "Investigation Evaluation (ephemeral)";

const THRESHOLDS = {
  recall: 0.9,
  precision: 0.6,
  gradingAccuracy: 0.85,
} as const;

type CaseReport = {
  name: string;
  expected: string[];
  selected: string[];
  /** Every selected source with its grade, for inspection. */
  selectedDetail: Array<{ key: string; relevance: string; expected: boolean }>;
  matched: string[];
  missing: string[];
  unexpected: string[];
  forbiddenHits: string[];
  gradingCorrect: number;
  gradingChecked: number;
  duplicates: number;
  weakOnlyViolations: number;
  warnings: string[];
  latencyMs: number;
};

function keyOf(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
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
    weakOnlyViolations: 0,
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

async function seedCorpus(
  organizationId: string
): Promise<Map<string, string>> {
  const sourceByKey = new Map<string, string>();

  for (const document of evaluationDocuments) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO documents (organization_id, filename, content, content_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        organizationId,
        document.filename,
        document.content,
        hashContent(document.content),
      ]
    );
    const documentId = inserted.rows[0]!.id;
    sourceByKey.set(keyOf("document", documentId), document.key);
    await indexDocument({ organizationId, documentId });
  }

  for (const ticket of evaluationTickets) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO tickets (organization_id, title, description, status, priority)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        organizationId,
        ticket.title,
        ticket.description,
        ticket.status,
        ticket.priority,
      ]
    );
    const ticketId = inserted.rows[0]!.id;
    sourceByKey.set(keyOf("ticket", ticketId), ticket.key);
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
    }
  }

  return sourceByKey;
}

function evaluateCase(input: {
  testCase: InvestigationEvaluationCase;
  evidence: Array<{
    sourceType: string;
    sourceId: string;
    relevance: string;
  }>;
  warnings: string[];
  latencyMs: number;
  sourceByKey: Map<string, string>;
}): CaseReport {
  const report = emptyReport(input.testCase.name);
  const expectedKeys = input.testCase.expected.map((item) => item.key);
  report.expected = expectedKeys;

  const selectedKeys = input.evidence.map(
    (item) => input.sourceByKey.get(keyOf(item.sourceType, item.sourceId)) ??
      keyOf(item.sourceType, item.sourceId)
  );
  report.selected = selectedKeys;
  report.selectedDetail = input.evidence.map((item) => ({
    key:
      input.sourceByKey.get(keyOf(item.sourceType, item.sourceId)) ??
      keyOf(item.sourceType, item.sourceId),
    relevance: item.relevance,
    expected: expectedKeys.includes(
      input.sourceByKey.get(keyOf(item.sourceType, item.sourceId)) ??
        keyOf(item.sourceType, item.sourceId)
    ),
  }));
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

  for (const item of input.evidence) {
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
    } else if (
      input.testCase.weakOnly === true &&
      item.relevance !== "weak"
    ) {
      report.weakOnlyViolations += 1;
    }
  }

  report.missing = expectedKeys.filter((key) => !report.matched.includes(key));

  return report;
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
  const organizationId = await ensureOrganization();
  const userId = await ensureUser();

  if (!keep) {
    await clearOrganization(organizationId);
  }

  console.log(`Seeding corpus into organisation ${organizationId}…`);
  const sourceByKey = await seedCorpus(organizationId);

  const reports: CaseReport[] = [];

  for (const testCase of investigationEvaluationCases) {
    const created = await createInvestigation({
      organizationId,
      userId,
      payload: testCase.investigation,
    });
    const investigationId = created.detail.investigation.id;

    const startedAt = Date.now();
    const collection = await collectInvestigationEvidence({
      organizationId,
      investigationId,
      userId,
    });
    const latencyMs = Date.now() - startedAt;
    const detail = await getInvestigationDetail(organizationId, investigationId);

    reports.push(
      evaluateCase({
        testCase,
        evidence: detail.evidence,
        warnings: collection.summary.warnings,
        latencyMs,
        sourceByKey,
      })
    );
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
      console.log(
        `  ${item.expected ? "found" : "extra"}  ${item.key} [${item.relevance}]`
      );
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
    if (report.weakOnlyViolations > 0) {
      const strong = report.selectedDetail.filter(
        (item) => item.relevance !== "weak"
      );
      console.log(
        `  weak-only violated: ${strong
          .map((item) => `${item.key} [${item.relevance}]`)
          .join(", ")}`
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
  const weakOnlyViolations = reports.reduce(
    (sum, report) => sum + report.weakOnlyViolations,
    0
  );

  const aggregate = {
    cases: reports.length,
    positiveCases: positive.length,
    recall: mean(recalls),
    precision: mean(precisions),
    gradingAccuracy,
    duplicateViolations,
    forbiddenHits,
    weakOnlyViolations,
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
  if (weakOnlyViolations > 0) {
    failures.push(
      `${weakOnlyViolations} item(s) presented as stronger than weak without matching evidence`
    );
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
