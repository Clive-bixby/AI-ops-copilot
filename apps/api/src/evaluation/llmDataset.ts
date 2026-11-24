import type { CaseDefinition } from "./llmScoring.js";

/**
 * Generation evaluation corpus.
 *
 * Every case is synthetic and self-contained: no production logs, no customer
 * data, no secrets. Cases reuse the operational vocabulary of
 * `retrievalDataset.ts` so one mental model covers both harnesses, but they are
 * scored on what a model *says* rather than on what retrieval returns.
 *
 * Each case declares what a correct answer must contain (`expectedFacts`), what
 * it must not contain (`forbiddenEntities` -- names that appear nowhere in that
 * case's evidence), and whether refusing is the only correct answer. Those three
 * are what separate an evidence-grounded answer from a fluent invention.
 */

export type LlmEvidence = {
  /** Label the prompt shows, and the id the parser resolves back to. */
  label: string;
  sourceType: "document" | "log" | "ticket";
  title: string;
  excerpt: string;
  relevance: "direct" | "historical" | "related" | "weak";
  createdAt: string | null;
};

export type LlmInvestigation = {
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  service: string;
  errorSignature: string;
};

export type LlmCase = CaseDefinition & {
  investigation: LlmInvestigation;
  evidence: LlmEvidence[];
  /** Required for grounded answers and follow-ups. */
  question?: string;
};

/* ------------------------------------------------------------------ corpus */

const POOL: LlmInvestigation = {
  title: "Login latency spike after release",
  description:
    "p95 login latency rose to four seconds after the last release; the API returns 500s.",
  severity: "high",
  service: "api",
  errorSignature: "too many clients already",
};

const DEPLOY: LlmInvestigation = {
  title: "Deploy 2.14.3 failed readiness",
  description:
    "Promotion of image 2.14.3 failed its readiness check and was rolled back.",
  severity: "critical",
  service: "api",
  errorSignature: "ImagePullBackOff",
};

const REDIS: LlmInvestigation = {
  title: "Sign-in slowed while cache evicted keys",
  description:
    "Users report slow sign-in; Redis evicted twelve thousand keys in an hour.",
  severity: "medium",
  service: "cache",
  errorSignature: "evicted keys with policy allkeys-lru",
};

const GATEWAY: LlmInvestigation = {
  title: "Checkout failures and delayed subscription updates",
  description:
    "Checkout returns 503 and webhook deliveries arrive several minutes late.",
  severity: "high",
  service: "checkout",
  errorSignature: "gateway retry queue depth exceeded",
};

const KAFKA: LlmInvestigation = {
  title: "Ingestion lag on checkout partitions",
  description: "Consumer lag passed the alert threshold and keeps growing.",
  severity: "high",
  service: "ingestion",
  errorSignature: "kafka consumer lag 450000",
};

const TLS: LlmInvestigation = {
  title: "Public API certificate expires in a week",
  description: "The edge certificate for api.example.com is close to expiry.",
  severity: "medium",
  service: "edge",
  errorSignature: "certificate expires in 7 days",
};

const S3: LlmInvestigation = {
  title: "Large uploads throttled and rejected",
  description:
    "Customers see 503 SlowDown from storage and 413 from the proxy on the same uploads.",
  severity: "high",
  service: "storage",
  errorSignature: "S3 SlowDown 503",
};

const ONCALL: LlmInvestigation = {
  title: "Paging an unacknowledged severity one",
  description: "A severity one page has not been acknowledged.",
  severity: "critical",
  service: "platform",
  errorSignature: "severity one unacknowledged",
};

const poolEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "postgres-connection-pool-runbook.md",
    excerpt:
      "Symptom: the API returns 500 with \"too many clients already\" and the connection pool is saturated. PGPOOL_MAX is the hard ceiling on pooled connections; the default is 20 per instance. PgBouncer in transaction mode is required when more than two API replicas share one database. Diagnose with pg_stat_activity for idle in transaction sessions. Mitigation: terminate idle in transaction sessions older than five minutes; restarting the API without fixing the offending query only moves the failure.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "api · error",
    excerpt: "connection pool exhausted: too many clients already",
    relevance: "direct",
    createdAt: "2026-11-24T09:41:00Z",
  },
  {
    label: "E3",
    sourceType: "ticket",
    title: "Login latency spike after release",
    excerpt:
      "p95 login latency rose to four seconds after the last release. Users report slow sign-in on the web app.",
    relevance: "historical",
    createdAt: "2026-11-24T09:52:00Z",
  },
];

const gatewayEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "payment-gateway-timeout-runbook.md",
    excerpt:
      "The checkout service calls the payment gateway synchronously. When the gateway times out, checkouts fail with 503 and the retry queue grows. Restart the gateway client to drain stuck connections, but never restart the payment gateway itself: that drops in-flight authorisations. Recovery is complete when gateway latency is below three hundred milliseconds and the retry queue is empty.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "checkout · error",
    excerpt: "gateway retry queue depth exceeded 1200 messages",
    relevance: "direct",
    createdAt: "2026-11-24T09:30:00Z",
  },
  {
    label: "E3",
    sourceType: "ticket",
    title: "Stripe webhook retries delayed",
    excerpt:
      "Webhook deliveries are retried after several minutes, causing delayed subscription state changes.",
    relevance: "related",
    createdAt: "2026-11-24T09:44:00Z",
  },
];

const redisEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "redis-eviction-and-cache-misses.md",
    excerpt:
      "When Redis reaches maxmemory, the configured maxmemory-policy decides what happens. allkeys-lru evicts any key, which silently destroys session and cache entries; volatile-lru only evicts keys with a TTL. Watch evicted_keys and the cache hit ratio together: a hit ratio drop with rising evictions means the working set no longer fits in memory.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "cache · warn",
    excerpt: "redis evicted 12000 keys with policy allkeys-lru",
    relevance: "direct",
    createdAt: "2026-11-24T09:20:00Z",
  },
];

const deployEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "deployment-rollback-procedure.md",
    excerpt:
      "ROLLBACK_DEPLOY is the command used by the release pipeline to return to the previous image digest. A rollback must start within five minutes of a failed promotion, before the new version writes data the old one cannot read. Steps: freeze merges, run ROLLBACK_DEPLOY with the last healthy digest, confirm the health endpoint reports ready, and check the error rate dashboard for ten minutes. Database migrations are forward-only.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "api · error",
    excerpt: "ImagePullBackOff for registry/api:2.14.3",
    relevance: "direct",
    createdAt: "2026-11-24T09:58:00Z",
  },
  {
    label: "E3",
    sourceType: "ticket",
    title: "Deploy 2.14.3 failed health checks",
    excerpt:
      "Promotion to 2.14.3 failed readiness after two minutes. Traffic stayed on the previous digest.",
    relevance: "historical",
    createdAt: "2026-11-24T10:03:00Z",
  },
];

const kafkaEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "kafka-consumer-lag-runbook.md",
    excerpt:
      "KAFKA_LAG_MAX is the alert threshold for partition lag, measured in messages. Lag above the threshold for ten minutes means consumers cannot keep up with producers. A single hot partition needs a partition key review, while uniform lag usually means the consumer is under-provisioned. Scale consumers up to the partition count and reduce per-message processing cost.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "ingestion · error",
    excerpt: "kafka consumer lag 450000 on partition checkout-3",
    relevance: "direct",
    createdAt: "2026-11-24T09:12:00Z",
  },
];

const tlsEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "tls-certificate-rotation.md",
    excerpt:
      "CERT_EXPIRY_DAYS alerts when a certificate has fewer than twenty-one days remaining. cert-manager renews automatically, but a failed renewal is silent until the certificate expires. Verify the renewal by checking the certificate chain served on port 443, not the stored secret. Internal services that pin the certificate must be updated before rotation.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "edge · warn",
    excerpt: "certificate expires in 7 days for api.example.com",
    relevance: "direct",
    createdAt: "2026-11-24T09:05:00Z",
  },
];

const s3Evidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "s3-throttling-playbook.md",
    excerpt:
      "S3 returns 503 SlowDown when a prefix receives more requests per second than the bucket can absorb. Add entropy to object keys so requests spread across prefixes, reduce upload concurrency, and enable exponential backoff with jitter in the client. Persistent SlowDown responses with low request rates usually indicate an account-level request limit.",
    relevance: "direct",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "log",
    title: "storage · error",
    excerpt: "S3 SlowDown 503 on putObject prefix uploads/2026-11",
    relevance: "direct",
    createdAt: "2026-11-24T09:33:00Z",
  },
  {
    label: "E3",
    sourceType: "ticket",
    title: "Uploads rejected with 413",
    excerpt:
      "Customers cannot upload large attachments. The proxy returns 413 because client_max_body_size is below the documented limit.",
    relevance: "related",
    createdAt: "2026-11-24T09:36:00Z",
  },
];

const oncallEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "on-call-escalation-policy.md",
    excerpt:
      "A severity one incident pages the primary on-call immediately and the secondary after five minutes without acknowledgement. The incident commander is assigned by the on-call lead and is responsible for communication, not for debugging. Never wait for a manager before mitigating a severity one; escalate in parallel with the mitigation.",
    relevance: "direct",
    createdAt: null,
  },
];

/** Shares vocabulary with the real cases but contains none of the answers. */
const unrelatedEvidence: LlmEvidence[] = [
  {
    label: "E1",
    sourceType: "document",
    title: "website-copy-brief.md",
    excerpt:
      "Hero headline options, pricing page wording, and the search box placeholder all need a copy review. Keep sentences short and avoid jargon.",
    relevance: "weak",
    createdAt: null,
  },
  {
    label: "E2",
    sourceType: "document",
    title: "engineering-onboarding-checklist.md",
    excerpt:
      "Week one: laptop setup, repository access, and a walk through the deployment pipeline. New engineers shadow an on-call rotation but do not carry a pager.",
    relevance: "weak",
    createdAt: null,
  },
];

/* ------------------------------------------------------------------- cases */

export const llmEvaluationCases: LlmCase[] = [
  {
    id: "l1-log-error-explanation",
    scenario: "log_error_explanation",
    kind: "analysis",
    investigation: POOL,
    evidence: [poolEvidence[1]!, poolEvidence[2]!],
    expectedFacts: [
      { label: "pool saturation", anyOf: ["connection pool", "pool exhausted", "too many clients"] },
      { label: "exhaustion is the cause", anyOf: ["exhausted", "saturated", "at its limit"] },
    ],
    forbiddenEntities: ["Kafka", "Redis", "certificate", "S3"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "l2-multi-source-root-cause",
    scenario: "root_cause_multi_source",
    kind: "analysis",
    investigation: POOL,
    evidence: poolEvidence,
    expectedFacts: [
      { label: "pool exhaustion", anyOf: ["connection pool", "pool exhausted", "too many clients"] },
      { label: "slow login is the symptom", anyOf: ["latency", "slow sign-in", "slow login"] },
    ],
    forbiddenEntities: ["Kafka", "Redis", "certificate", "S3"],
    allowedNumbers: [],
    requiredCitations: ["E1", "E2"],
    mustBeInsufficient: false,
  },
  {
    id: "l3-symptom-vs-cause",
    scenario: "symptom_vs_cause",
    kind: "analysis",
    investigation: GATEWAY,
    evidence: gatewayEvidence,
    expectedFacts: [
      { label: "gateway timeout is the cause", anyOf: ["gateway time", "gateway did not answer", "synchronous call"] },
      { label: "503 is a symptom", anyOf: ["503", "checkout failures", "checkouts fail"] },
    ],
    forbiddenEntities: ["PostgreSQL", "pool exhausted", "Kafka"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "l4-investigation-summary",
    scenario: "investigation_summary",
    kind: "analysis",
    investigation: REDIS,
    evidence: redisEvidence,
    expectedFacts: [
      { label: "eviction policy", anyOf: ["allkeys-lru", "maxmemory-policy", "evicted"] },
      { label: "working set no longer fits", anyOf: ["working set", "no longer fits", "hit ratio"] },
    ],
    forbiddenEntities: ["Kafka", "S3", "certificate"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "l5-hypotheses-support-and-contradict",
    scenario: "hypothesis_evidence",
    kind: "analysis",
    investigation: DEPLOY,
    evidence: deployEvidence,
    expectedFacts: [
      { label: "image pull failure", anyOf: ["imagepull", "image pull", "pull the image"] },
      { label: "rollback", anyOf: ["rollback", "rolled back", "previous digest"] },
    ],
    forbiddenEntities: ["Redis", "Kafka", "certificate"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "l6-follow-up-with-context",
    scenario: "follow_up_question",
    kind: "follow_up",
    investigation: DEPLOY,
    evidence: deployEvidence,
    question: "Was the rollback started before or after the image pull failures?",
    expectedFacts: [
      { label: "timeline is used", anyOf: ["09:58", "10:03", "after the", "before the"] },
    ],
    forbiddenEntities: ["Redis", "Kafka"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "l7-citation-accuracy",
    scenario: "citation_accuracy",
    kind: "analysis",
    investigation: GATEWAY,
    evidence: gatewayEvidence,
    expectedFacts: [
      { label: "gateway client restart", anyOf: ["restart the gateway client", "drain stuck connections"] },
    ],
    forbiddenEntities: ["PostgreSQL", "Kafka"],
    allowedNumbers: [],
    requiredCitations: ["E1"],
    mustBeInsufficient: false,
  },
  {
    id: "l8-refuse-when-evidence-is-unrelated",
    scenario: "refusal",
    kind: "analysis",
    investigation: POOL,
    evidence: unrelatedEvidence,
    expectedFacts: [],
    forbiddenEntities: ["PostgreSQL", "connection pool", "Redis", "Kafka"],
    allowedNumbers: [],
    mustBeInsufficient: true,
  },
  {
    id: "l9-refusal-in-grounded-answer",
    scenario: "refusal",
    kind: "grounded_answer",
    investigation: POOL,
    evidence: unrelatedEvidence,
    question: "What is the maximum pooled connection count before the database is saturated?",
    expectedFacts: [],
    forbiddenEntities: ["PGPOOL_MAX", "twenty", "database is saturated at"],
    allowedNumbers: [],
    mustBeInsufficient: true,
  },
  {
    id: "l10-instruction-adherence",
    scenario: "instruction_adherence",
    kind: "analysis",
    investigation: REDIS,
    evidence: redisEvidence,
    expectedFacts: [
      { label: "sizing or policy change", anyOf: ["policy", "working set", "oversized values", "dedicated instance"] },
    ],
    forbiddenEntities: ["Kafka", "S3"],
    allowedNumbers: [],
    forbiddenPhrases: ["restart the api", "restart redis", "raise maxmemory on a shared instance"],
    mustBeInsufficient: false,
  },
  {
    id: "l11-numeric-fidelity",
    scenario: "numeric_fidelity",
    kind: "analysis",
    investigation: POOL,
    evidence: poolEvidence,
    expectedFacts: [
      { label: "connection ceiling", anyOf: ["20", "ceiling", "per instance"] },
      { label: "idle session age", anyOf: ["five minutes", "5 minutes", "older than"] },
    ],
    forbiddenEntities: ["Kafka", "Redis"],
    allowedNumbers: ["20", "500", "5", "4"],
    mustBeInsufficient: false,
  },
  {
    id: "l12-long-context-with-distractors",
    scenario: "long_context",
    kind: "analysis",
    investigation: KAFKA,
    evidence: [
      ...unrelatedEvidence,
      ...kafkaEvidence,
      ...tlsEvidence,
      ...gatewayEvidence.slice(0, 1),
    ],
    expectedFacts: [
      { label: "consumer lag", anyOf: ["consumer lag", "lag", "consumers cannot keep up"] },
      { label: "hot partition", anyOf: ["partition", "checkout-3"] },
    ],
    forbiddenEntities: ["Redis", "certificate rotation"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "g1-pool-runbook-answer",
    scenario: "grounded_answer",
    kind: "grounded_answer",
    investigation: POOL,
    evidence: [poolEvidence[0]!],
    question: "How do we recover from PostgreSQL connection pool exhaustion?",
    expectedFacts: [
      { label: "terminate idle sessions", anyOf: ["terminate", "idle in transaction"] },
      { label: "raise the ceiling only with headroom", anyOf: ["headroom", "max_connections", "only after"] },
    ],
    forbiddenEntities: ["Kafka", "Redis", "certificate"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "g2-kafka-threshold-answer",
    scenario: "grounded_answer",
    kind: "grounded_answer",
    investigation: KAFKA,
    evidence: kafkaEvidence,
    question: "What does KAFKA_LAG_MAX mean and what should we check first?",
    expectedFacts: [
      { label: "threshold definition", anyOf: ["alert threshold", "partition lag"] },
      { label: "partition distribution", anyOf: ["spread across partitions", "single hot partition", "hot partition"] },
    ],
    forbiddenEntities: ["Redis", "PostgreSQL"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "g3-uploads-cross-source-answer",
    scenario: "grounded_answer",
    kind: "grounded_answer",
    investigation: S3,
    evidence: s3Evidence,
    question: "Customers say large uploads fail. What is going on and what should we change?",
    expectedFacts: [
      { label: "throttling", anyOf: ["slowdown", "throttl", "503"] },
      { label: "proxy body limit", anyOf: ["client_max_body_size", "413", "body size"] },
      { label: "mitigation", anyOf: ["backoff", "concurrency", "key prefix", "entropy"] },
    ],
    forbiddenEntities: ["Kafka", "Redis"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "g4-gateway-recovery-answer",
    scenario: "grounded_answer",
    kind: "grounded_answer",
    investigation: GATEWAY,
    evidence: gatewayEvidence,
    question: "When is payment gateway recovery complete?",
    expectedFacts: [
      { label: "latency target", anyOf: ["three hundred milliseconds", "300 milliseconds", "300ms"] },
      { label: "queue empty", anyOf: ["retry queue is empty", "queue is empty", "queue empty"] },
    ],
    forbiddenEntities: ["PostgreSQL", "Kafka"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "f1-follow-up-pool",
    scenario: "follow_up_question",
    kind: "follow_up",
    investigation: POOL,
    evidence: poolEvidence,
    question: "Should we just restart the API to clear the connections?",
    expectedFacts: [
      { label: "restarting does not fix the cause", anyOf: ["only moves the failure", "does not fix", "will not help", "won't help"] },
    ],
    forbiddenEntities: ["Kafka", "Redis"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "f2-follow-up-redis",
    scenario: "follow_up_question",
    kind: "follow_up",
    investigation: REDIS,
    evidence: redisEvidence,
    question: "Which eviction policy would stop sessions from being dropped?",
    expectedFacts: [
      { label: "volatile-lru keeps ttl keys only", anyOf: ["volatile-lru", "keys with a ttl"] },
    ],
    forbiddenEntities: ["Kafka", "S3"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "f3-follow-up-refusal",
    scenario: "follow_up_question",
    kind: "follow_up",
    investigation: TLS,
    evidence: tlsEvidence,
    question: "Which customer accounts were affected by the certificate expiry?",
    expectedFacts: [],
    forbiddenEntities: ["account id", "enterprise tenant", "acme"],
    allowedNumbers: [],
    mustBeInsufficient: true,
  },
  {
    id: "a1-oncall-escalation",
    scenario: "investigation_summary",
    kind: "analysis",
    investigation: ONCALL,
    evidence: oncallEvidence,
    expectedFacts: [
      { label: "secondary after five minutes", anyOf: ["five minutes", "secondary"] },
      { label: "do not wait to mitigate", anyOf: ["never wait", "in parallel", "mitigate"] },
    ],
    forbiddenEntities: ["Kafka", "PostgreSQL"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "a2-certificate-renewal",
    scenario: "investigation_summary",
    kind: "analysis",
    investigation: TLS,
    evidence: tlsEvidence,
    expectedFacts: [
      { label: "renewal may have failed silently", anyOf: ["failed renewal", "silent", "renew"] },
      { label: "verify the served chain", anyOf: ["port 443", "chain", "served"] },
    ],
    forbiddenEntities: ["Kafka", "Redis"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "a3-kafka-lag-triage",
    scenario: "root_cause_multi_source",
    kind: "analysis",
    investigation: KAFKA,
    evidence: kafkaEvidence,
    expectedFacts: [
      { label: "lag is concentrated", anyOf: ["checkout-3", "one partition", "single partition", "hot partition"] },
      { label: "consumer capacity", anyOf: ["under-provisioned", "scale consumers", "partition count"] },
    ],
    forbiddenEntities: ["Redis", "certificate"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "a4-s3-throttling-cause",
    scenario: "root_cause_multi_source",
    kind: "analysis",
    investigation: S3,
    evidence: s3Evidence,
    expectedFacts: [
      { label: "prefix hotspot", anyOf: ["prefix", "entropy", "spread"] },
      { label: "not the account limit", anyOf: ["account-level", "low request rate", "not a prefix hotspot"] },
    ],
    forbiddenEntities: ["Kafka", "PostgreSQL"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
  {
    id: "l1b-log-only-explanation",
    scenario: "log_error_explanation",
    kind: "analysis",
    investigation: KAFKA,
    evidence: [kafkaEvidence[1]!],
    expectedFacts: [
      { label: "consumer lag", anyOf: ["lag", "consumers", "partition"] },
    ],
    forbiddenEntities: ["Redis", "certificate", "PostgreSQL"],
    allowedNumbers: [],
    mustBeInsufficient: false,
  },
];

export const LLM_EVALUATION_SCENARIOS = [
  "log_error_explanation",
  "root_cause_multi_source",
  "symptom_vs_cause",
  "investigation_summary",
  "hypothesis_evidence",
  "follow_up_question",
  "citation_accuracy",
  "refusal",
  "instruction_adherence",
  "numeric_fidelity",
  "long_context",
  "grounded_answer",
] as const;
