/**
 * Labelled corpus for investigation-quality evaluation.
 *
 * Each case is a realistic investigation whose answer is known in advance: the
 * sources that must be found, how each should be graded, and the distractors that
 * must not be presented as evidence. The corpus is seeded through the production
 * ingestion path, so the harness measures the real collection code.
 */

export type EvaluationRelevance = "direct" | "historical" | "related" | "weak";

export type EvaluationDocumentSeed = {
  key: string;
  filename: string;
  content: string;
};

export type EvaluationTicketSeed = {
  key: string;
  title: string;
  description: string;
  status: string;
  priority: string;
};

export type EvaluationLogSeed = {
  key: string;
  level: "warn" | "error" | "fatal";
  message: string;
  service: string;
  minutesAgo: number;
  /** Substring used to find the log group that grouping produced. */
  marker: string;
};

export type EvaluationExpectedEvidence = {
  key: string;
  /** Any of these grades is correct; documents may be related or direct. */
  allowedRelevance: EvaluationRelevance[];
};

export type InvestigationEvaluationCase = {
  name: string;
  investigation: {
    title: string;
    description: string;
    severity: "low" | "medium" | "high" | "critical";
    service: string;
    errorSignature: string;
  };
  /** Empty means the honest answer is "no evidence". */
  expected: EvaluationExpectedEvidence[];
  /** Sources that must never be selected for this case. */
  forbidden: string[];
  /**
   * For a no-evidence case, any selection must be graded weak: the system may
   * offer low-confidence context but must not claim it is direct evidence.
   */
  weakOnly?: boolean;
};

export const evaluationDocuments: EvaluationDocumentSeed[] = [
  {
    key: "doc-pool-runbook",
    filename: "postgres-connection-pool-runbook.md",
    content: `PostgreSQL connection pool exhaustion

Symptom: the API returns HTTP 500 with "too many clients already" and the connection pool is saturated. PGPOOL_MAX is the hard ceiling on pooled connections; the default is 20 per instance. PgBouncer in transaction mode is required when more than two API replicas share one database.

Diagnosis: query pg_stat_activity for idle in transaction sessions and check the pool wait time metric. A single long-running transaction can hold a connection for minutes and starve every request behind it.

Mitigation: terminate idle in transaction sessions older than five minutes, raise PGPOOL_MAX only after confirming database max_connections headroom, and route reporting jobs through the read replica.`,
  },
  {
    key: "doc-deploy-rollback",
    filename: "deployment-rollback-runbook.md",
    content: `Deployment rollback procedure

When a release fails, first confirm the image digest actually exists in the registry and that the cluster can authenticate to it. An image pull error (ImagePullBackOff, ErrImagePull) means the pod never started, so the previous version is still serving whatever traffic the failing replica would have handled.

Roll back with kubectl rollout undo deployment/<name> and verify the rollout status. Check the registry credential secret and the image tag; a typo in the tag is the most common cause. Record the failing digest in the incident timeline.`,
  },
  {
    key: "doc-redis-maxmemory",
    filename: "redis-memory-policy.md",
    content: `Redis memory and eviction policy

Redis rejects writes with "OOM command not allowed when used memory > 'maxmemory'" once the maxmemory limit is reached. allkeys-lru evicts the least recently used keys and is appropriate for a pure cache; volatile-lru only evicts keys with a TTL, which silently leaves persistent keys holding memory.

Watch evicted_keys and used_memory_rss. Session caches should set a TTL on every key so eviction is possible, and a cache miss must be handled by re-reading the session from the database.`,
  },
  {
    key: "doc-billing-retries",
    filename: "billing-retry-policy.md",
    content: `Invoice retry policy

Failed invoice charges are retried three times with exponential backoff. A payment gateway 402 response is a hard decline and must not be retried. Refunds are processed within five business days.`,
  },
  {
    key: "doc-oncall-escalation",
    filename: "on-call-escalation-policy.md",
    content: `On-call escalation

A severity one incident pages the primary on-call immediately and the secondary after five minutes without acknowledgement. Severity two pages the primary only and is acknowledged within fifteen minutes.`,
  },
];

export const evaluationTickets: EvaluationTicketSeed[] = [
  {
    key: "ticket-pool-release",
    title: "Connection pool exhausted after release",
    description:
      "The API returned 500 with too many clients already. Raising PGPOOL_MAX and terminating idle transactions resolved it; the release had left a migration holding a connection.",
    status: "resolved",
    priority: "high",
  },
  {
    key: "ticket-deploy-rollback",
    title: "Release 1.42.0 rolled back after image pull failures",
    description:
      "Pods failed with ImagePullBackOff because the image tag did not exist. Rolling back to 1.41.3 restored service.",
    status: "resolved",
    priority: "urgent",
  },
  {
    key: "ticket-redis-eviction",
    title: "Session misses during Redis memory pressure",
    description:
      "Redis hit maxmemory and rejected writes. Raising maxmemory and switching to allkeys-lru stopped the session misses.",
    status: "resolved",
    priority: "medium",
  },
];

export const evaluationLogs: EvaluationLogSeed[] = [
  {
    key: "log-pool-exhausted",
    level: "error",
    message:
      "connection pool exhausted: too many clients already (host db-1)",
    service: "api",
    minutesAgo: 40,
    marker: "connection pool exhausted",
  },
  {
    key: "log-imagepull",
    level: "error",
    message:
      "Failed to pull image registry.internal/api:1.42.0: ImagePullBackOff (manifest unknown)",
    service: "ingress",
    minutesAgo: 25,
    marker: "ImagePullBackOff",
  },
  {
    key: "log-redis-oom",
    level: "error",
    message:
      "OOM command not allowed when used memory > 'maxmemory' (session writes rejected)",
    service: "cache",
    minutesAgo: 15,
    marker: "OOM command not allowed",
  },
  {
    key: "log-cron-noise",
    level: "warn",
    message: "Scheduled report job finished in 42 seconds",
    service: "reports",
    minutesAgo: 5,
    marker: "Scheduled report job",
  },
];

export const investigationEvaluationCases: InvestigationEvaluationCase[] = [
  {
    name: "pool-exhaustion",
    investigation: {
      title: "Checkout returns HTTP 500 under load",
      description:
        "Since 09:40 checkout requests intermittently return HTTP 500 with a database connection error, and response times spike before each burst of failures.",
      severity: "high",
      service: "api",
      errorSignature: "connection pool exhausted: too many clients already",
    },
    expected: [
      { key: "log-pool-exhausted", allowedRelevance: ["direct"] },
      { key: "ticket-pool-release", allowedRelevance: ["historical"] },
      { key: "doc-pool-runbook", allowedRelevance: ["related", "direct"] },
    ],
    forbidden: [
      "doc-billing-retries",
      "doc-oncall-escalation",
      "log-cron-noise",
    ],
  },
  {
    name: "deploy-rollback",
    investigation: {
      title: "Release 1.42.0 fails with 502 responses",
      description:
        "After deploying release 1.42.0 the ingress returns 502 and pods restart with image pull errors from the internal registry.",
      severity: "critical",
      service: "ingress",
      errorSignature: "ImagePullBackOff",
    },
    expected: [
      { key: "log-imagepull", allowedRelevance: ["direct"] },
      { key: "ticket-deploy-rollback", allowedRelevance: ["historical"] },
      { key: "doc-deploy-rollback", allowedRelevance: ["related", "direct"] },
    ],
    forbidden: ["doc-billing-retries", "log-cron-noise"],
  },
  {
    name: "redis-eviction",
    investigation: {
      title: "Session cache misses under memory pressure",
      description:
        "Session lookups intermittently miss and p99 latency spikes while Redis memory usage keeps growing.",
      severity: "medium",
      service: "cache",
      errorSignature: "OOM command not allowed when used memory > 'maxmemory'",
    },
    expected: [
      { key: "log-redis-oom", allowedRelevance: ["direct"] },
      { key: "ticket-redis-eviction", allowedRelevance: ["historical"] },
      { key: "doc-redis-maxmemory", allowedRelevance: ["related", "direct"] },
    ],
    forbidden: ["doc-oncall-escalation", "log-cron-noise"],
  },
  {
    name: "no-matching-evidence",
    investigation: {
      title: "SSO login failures after certificate rotation",
      description:
        "Users cannot sign in through the identity provider; the SAML signing certificate expired overnight.",
      severity: "high",
      service: "auth",
      errorSignature: "x509: certificate has expired or is not yet valid",
    },
    expected: [],
    forbidden: [],
    weakOnly: true,
  },
];
