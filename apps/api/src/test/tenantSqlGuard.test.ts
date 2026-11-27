import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static guard for tenant-scoped SQL.
 *
 * There is no Row Level Security, so a query that forgets `organization_id` is a
 * silent cross-tenant leak. The behavioural suites in `test/integration` prove
 * the routes are scoped *today*; this test is the tripwire for the next query
 * someone adds. It is deliberately crude — it reads SQL literals, not a parser —
 * so it errs towards flagging, and every exception is an explicit, reviewed
 * allow-list entry with a reason.
 *
 * Scope: every non-test TypeScript file under `src/modules`, because that is
 * where application SQL lives.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULES_ROOT = path.resolve(TEST_DIR, "../modules");

/**
 * Tables whose rows belong to exactly one organization. `users`, `organizations`
 * and `memberships` are intentionally absent: they are keyed by user id or
 * resolved through a membership, not filtered by `organization_id`.
 */
export const TENANT_TABLES = [
  "action_item_events",
  "action_items",
  "document_chunks",
  "documents",
  "ingest_idempotency",
  "ingestion_jobs",
  "investigation_activity",
  "investigation_analyses",
  "investigation_evidence",
  "investigation_hypotheses",
  "investigation_hypothesis_evidence",
  "investigations",
  "log_groups",
  "logs",
  "source_chunks",
  "tickets",
] as const;

const TABLE_REFERENCE = new RegExp(
  `\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:public\\.)?(${TENANT_TABLES.join("|")})\\b`,
  "i"
);

const SQL_VERB = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;
const TENANT_PREDICATE = /\borganization_id\b/i;

/** `${...}` is a JavaScript expression, not SQL: blank it before inspecting. */
export function normalizeSql(literal: string): string {
  return literal
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function referencesTenantTable(statement: string): boolean {
  return TABLE_REFERENCE.test(statement);
}

export function isSqlStatement(statement: string): boolean {
  return SQL_VERB.test(statement) && referencesTenantTable(statement);
}

/** Every template literal in a source file, normalized. */
export function extractSqlLiterals(source: string): string[] {
  const literals: string[] = [];
  const pattern = /`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const statement = normalizeSql(match[1] ?? "");
    if (statement.length > 0) literals.push(statement);
  }

  return literals.filter(isSqlStatement);
}

/**
 * Statements that legitimately have no `organization_id`, each reviewed by hand.
 * `contains` must match the normalized statement, and a stale entry fails the
 * suite so the list cannot quietly rot.
 */
const ALLOWED_WITHOUT_ORGANIZATION_ID: Array<{
  file: string;
  contains: string;
  reason: string;
}> = [
  {
    file: "actionItems/service.ts",
    contains: "FROM investigation_analyses WHERE id = $1 AND investigation_id = $2",
    reason:
      "Runs inside the transaction that locked the investigation with organization_id; " +
      "the composite foreign key ties the analysis to that investigation.",
  },
  {
    file: "actionItems/service.ts",
    contains: "FROM investigation_hypotheses WHERE id = $1 AND investigation_id = $2",
    reason:
      "Same transaction and lock as the analysis lookup above; provenance must be correct, " +
      "not merely tenant-correct.",
  },
  {
    file: "ingestion/idempotency.service.ts",
    contains: "DELETE FROM ingest_idempotency WHERE id = $1",
    reason:
      "Primary key of a row this request created under its own organization-scoped key.",
  },
  {
    file: "ingestion/idempotency.service.ts",
    contains: "UPDATE ingest_idempotency SET response_status = $2",
    reason:
      "Primary key of the row inserted by this request, after the organization-scoped lookup.",
  },
  {
    file: "ingestion/jobQueue.ts",
    contains: "FROM ingestion_jobs WHERE ORDER BY created_at DESC",
    reason:
      "Fragment: `${JOB_COLUMNS}` and the WHERE clause are interpolated; the conditions " +
      "array starts with 'organization_id = $1' and is exercised by tenancy.itest.ts.",
  },
  {
    file: "insights/operations.service.ts",
    contains: "COUNT(*) AS total FROM action_items ai",
    reason:
      "Fragment: callers append the WHERE clause, which starts with ai.organization_id.",
  },
  {
    file: "investigations/analysis.service.ts",
    contains: "DELETE FROM investigation_hypothesis_evidence WHERE hypothesis_id = $1",
    reason:
      "hypothesis_id was just inserted in this transaction for the same organization's " +
      "investigation; links are replaced, never read across tenants.",
  },
  {
    file: "investigations/analysis.service.ts",
    contains: "UPDATE investigation_hypotheses SET status = $3",
    reason:
      "Runs immediately after the row was locked with 'AND organization_id = $3' in the " +
      "same transaction.",
  },
];

export type Violation = { file: string; statement: string };

/** Tenant statements with no `organization_id`, allow-list ignored. */
export function findUnscopedStatements(
  files: Array<{ file: string; source: string }>
): Violation[] {
  const statements: Violation[] = [];

  for (const { file, source } of files) {
    for (const statement of extractSqlLiterals(source)) {
      if (TENANT_PREDICATE.test(statement)) continue;
      statements.push({ file, statement });
    }
  }

  return statements;
}

export function findViolations(
  files: Array<{ file: string; source: string }>
): Violation[] {
  return findUnscopedStatements(files).filter(
    (violation) =>
      !ALLOWED_WITHOUT_ORGANIZATION_ID.some(
        (entry) =>
          entry.file === violation.file && violation.statement.includes(entry.contains)
      )
  );
}

function moduleFiles(): Array<{ file: string; source: string }> {
  const entries = readdirSync(MODULES_ROOT, { recursive: true }) as string[];

  return entries
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => !entry.endsWith(".test.ts") && !entry.endsWith(".itest.ts"))
    .map((entry) => {
      const file = entry.split(path.sep).join("/");
      return { file, source: readFileSync(path.join(MODULES_ROOT, entry), "utf8") };
    });
}

describe("tenant-scoped SQL", () => {
  it("flags a query that touches a tenant table without organization_id", () => {
    const violations = findViolations([
      {
        file: "modules/demo.service.ts",
        source: [
          "const rows = await pool.query(`SELECT id, filename FROM documents WHERE id = $1`, [id]);",
          "const scoped = await pool.query(`SELECT id FROM documents WHERE id = $1 AND organization_id = $2`, [id, org]);",
          "const members = await pool.query(`SELECT id FROM memberships WHERE organization_id = $1`, [org]);",
          "const fragment = await pool.query(`LIMIT $1 OFFSET $2`, [limit, offset]);",
        ].join("\n"),
      },
    ]);

    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0]!.statement, /FROM documents WHERE id = \$1/);
  });

  it("does not require organization_id on a table that is not tenant-scoped", () => {
    const violations = findViolations([
      {
        file: "modules/demo.service.ts",
        source: "const rows = await pool.query(`SELECT email FROM users WHERE id = $1`, [id]);",
      },
    ]);

    assert.deepEqual(violations, []);
  });

  it("covers the module SQL it claims to cover", () => {
    const files = moduleFiles();
    const statements = files.flatMap((file) => extractSqlLiterals(file.source));

    // A regex that silently matches nothing would make every other assertion
    // here meaningless, so the scan proves it found real work.
    assert.ok(files.length >= 25, `only ${files.length} module files were scanned`);
    assert.ok(statements.length >= 60, `only ${statements.length} tenant statements were found`);
  });

  it("has no tenant query without an organization predicate", () => {
    const violations = findViolations(moduleFiles());
    const report = violations
      .map((violation) => `\n  ${violation.file}\n    ${violation.statement}`)
      .join("");

    assert.deepEqual(
      violations,
      [],
      `tenant SQL without an organization_id predicate (add the predicate, or a reviewed allow-list entry):${report}`
    );
  });

  it("keeps every allow-list entry justified by a real statement", () => {
    const statements = findUnscopedStatements(moduleFiles());
    const stale = ALLOWED_WITHOUT_ORGANIZATION_ID.filter(
      (entry) =>
        !statements.some(
          (item) => item.file === entry.file && item.statement.includes(entry.contains)
        )
    );

    assert.deepEqual(
      stale.map((entry) => `${entry.file}: ${entry.contains}`),
      [],
      "an allow-list entry matches no statement any more: remove it or fix its file name"
    );
  });
});
