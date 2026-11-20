/**
 * Retrieval evaluation corpus.
 *
 * The corpus is seeded into a dedicated organization by
 * `src/scripts/evaluateRetrieval.ts` and removed afterwards, so the numbers are
 * reproducible and do not depend on whatever documents happen to exist in the
 * developer database.
 *
 * Relevant sources are labelled per query by corpus key. Evaluation happens at
 * source level: a query about the rollback runbook is satisfied by that document,
 * regardless of which of its chunks ranked first.
 */

export type EvaluationDocument = {
  key: string;
  filename: string;
  content: string;
};

export type EvaluationTicket = {
  key: string;
  title: string;
  description: string;
  status: string;
  priority: string;
};

export type EvaluationLog = {
  key: string;
  level: string;
  message: string;
  service: string;
};

export type EvaluationQuery = {
  query: string;
  relevant: string[];
};

export const evaluationDocuments: EvaluationDocument[] = [
  {
    key: "d_pg_pool",
    filename: "postgres-connection-pool-runbook.md",
    content: `PostgreSQL connection pool exhaustion

Symptom: the API returns 500 with "too many clients already" and the connection pool is saturated. PGPOOL_MAX is the hard ceiling on pooled connections; the default is 20 per instance. PgBouncer in transaction mode is required when more than two API replicas share one database.

Diagnosis: query pg_stat_activity for idle in transaction sessions, and check the pool wait time metric. A single long-running transaction can hold a connection for minutes and starve every request behind it.

Mitigation: terminate idle in transaction sessions older than five minutes, raise PGPOOL_MAX only after confirming the database max_connections headroom, and route reporting jobs through the read replica. Restarting the API without fixing the offending query only moves the failure.`,
  },
  {
    key: "d_rollback",
    filename: "deployment-rollback-procedure.md",
    content: `Deployment rollback procedure

ROLLBACK_DEPLOY is the command used by the release pipeline to return to the previous image digest. A rollback must start within five minutes of a failed promotion, before the new version writes data the old one cannot read.

Steps: freeze merges to the affected service, run ROLLBACK_DEPLOY with the last healthy digest, confirm the health endpoint reports ready, and check the error rate dashboard for ten minutes. Database migrations are forward-only; if the release included a destructive migration, rollback requires the documented compensations instead of the image alone.

Record the failed digest, the error rate that triggered the rollback, and the time of recovery in the incident review.`,
  },
  {
    key: "d_redis",
    filename: "redis-eviction-and-cache-misses.md",
    content: `Redis memory eviction

When Redis reaches maxmemory, the configured maxmemory-policy decides what happens. allkeys-lru evicts any key, which silently destroys session and cache entries; volatile-lru only evicts keys with a TTL. Watch evicted_keys and the cache hit ratio together: a hit ratio drop with rising evictions means the working set no longer fits in memory.

Do not raise maxmemory on a shared instance without checking the host headroom. Prefer sizing the cache for the hot key set, shortening oversized values, and moving large secondary indexes to a dedicated instance.`,
  },
  {
    key: "d_kafka",
    filename: "kafka-consumer-lag-runbook.md",
    content: `Kafka consumer lag

KAFKA_LAG_MAX is the alert threshold for partition lag, measured in messages. Lag above the threshold for ten minutes means consumers cannot keep up with producers.

Check whether the lag is spread across partitions or concentrated on one partition: a single hot partition needs a partition key review, while uniform lag usually means the consumer is under-provisioned or blocked on downstream calls. A rebalance storm appears as repeated group membership changes and briefly doubles lag.

Scale consumers up to the partition count, reduce per-message processing cost, and pause non-critical producers before the lag reaches the retention window.`,
  },
  {
    key: "d_tls",
    filename: "tls-certificate-rotation.md",
    content: `TLS certificate rotation

CERT_EXPIRY_DAYS alerts when a certificate has fewer than twenty-one days remaining. cert-manager renews automatically, but a failed renewal is silent until the certificate expires and every client sees an expired certificate error.

Verify the renewal by checking the certificate chain served on port 443, not the stored secret. Internal services that pin the certificate must be updated before rotation. The trust store on the egress proxy is refreshed on the same schedule and must not lag behind the leaf certificate.`,
  },
  {
    key: "d_s3",
    filename: "s3-throttling-playbook.md",
    content: `S3 request throttling

S3 returns 503 SlowDown when a prefix receives more requests per second than the bucket can absorb. Large parallel uploads that share a single prefix trigger this most often.

Mitigation: add entropy to object keys so requests spread across prefixes, reduce upload concurrency, and enable exponential backoff with jitter in the client. Persistent SlowDown responses with low request rates usually indicate an account-level request limit rather than a prefix hotspot.

Do not retry immediately without backoff; that amplifies the throttle.`,
  },
  {
    key: "d_dns",
    filename: "dns-failover-runbook.md",
    content: `DNS failover

DNS_FAILOVER_TTL is set to 30 seconds for records used by regional failover. Longer TTLs keep clients pointed at a failed region long after the health check flips.

Failover is automatic when the primary health check fails twice consecutively. Investigate the health check endpoint before forcing a manual failover, because a failing health check from inside the primary region is often a local network fault, not a regional outage. After failover, confirm that the secondary region has capacity for the full traffic share.`,
  },
  {
    key: "d_oncall",
    filename: "on-call-escalation-policy.md",
    content: `On-call escalation policy

A severity one incident pages the primary on-call immediately and the secondary after five minutes without acknowledgement. The incident commander is assigned by the on-call lead and is responsible for communication, not for debugging.

Severity two pages the primary only and is acknowledged within fifteen minutes. Severity three is handled during business hours through the normal support queue. Never wait for a manager before mitigating a severity one; escalate in parallel with the mitigation.

Every page must name the service, the customer impact, and the dashboard to open first.`,
  },
  {
    key: "d_flags",
    filename: "feature-flag-kill-switch.md",
    content: `Feature flag kill switch

FLAG_KILL_SWITCH disables a risky feature without a deployment. Each production flag must have a documented kill switch and an owner. Disabling checkout_v2 returns traffic to the legacy flow within one minute because the flag is evaluated on every request.

Test the kill switch in staging before relying on it during an incident. A flag that requires a restart is not a kill switch. Remove flags after the rollout completes; stale flags become hidden control flow that nobody dares to change.`,
  },
  {
    key: "d_rate",
    filename: "api-rate-limiting.md",
    content: `API rate limiting

The public API answers 429 when a client exceeds its token bucket. RATE_LIMIT_BURST controls the bucket size and the sustained rate is per API key. Clients must honour the Retry-After header instead of retrying immediately.

If legitimate traffic is being limited, first check whether one integration is looping, then raise the limit for that key deliberately. Rate limits are enforced per organization, so a noisy tenant cannot exhaust the shared capacity of another tenant.`,
  },
  {
    key: "d_vector",
    filename: "vector-index-rebuild.md",
    content: `Vector index rebuild

REINDEX INDEX CONCURRENTLY rebuilds the HNSW index without blocking reads. Use it after large bulk imports or after changing the embedding model, because vectors from different models are not comparable.

A rebuild needs temporary disk equal to the index size and can take longer than the write traffic allows on a busy primary; schedule it during low traffic. After the rebuild, verify that query latency returned to baseline and that the embedding dimensions recorded on each row match the current model.`,
  },
  {
    key: "d_backup",
    filename: "database-restore-drill.md",
    content: `Database restore drill

Point in time recovery restores the cluster to a timestamp using the continuous WAL archive. The restore target must be a new instance; never overwrite the primary.

The drill validates the recovery time objective of thirty minutes and the recovery point objective of five minutes. After the restore, run the integrity checks, compare row counts for the largest tables, and confirm that the application connects with a read-only role until the cutover is approved.

Record the measured restore duration for every drill; an untested backup is not a backup.`,
  },
  {
    key: "d_error_code",
    filename: "error-code-xj-4471.md",
    content: `Error code XJ-4471

The batch reconciliation worker rejects a settlement file with XJ-4471 when the settlement currency does not match the ledger currency for the merchant account. The rejection is recorded in the reconciliation dashboard and the file is moved to the quarantine bucket.

Resolution: confirm the merchant currency in the billing profile, correct the settlement file, and replay it through the reconciliation queue. Do not edit the ledger manually. If the currency is correct in both systems, open a ticket with the payments platform team and include the XJ-4471 trace identifier.`,
  },
  {
    key: "d_gateway",
    filename: "payment-gateway-timeout-runbook.md",
    content: `Payment gateway timeouts

The checkout service calls the payment gateway synchronously. When the gateway times out, checkouts fail with 503 and the retry queue grows.

Restart the gateway client to drain stuck connections, but never restart the payment gateway itself: that drops in-flight authorisations. If the queue keeps growing after the client restart, disable the optional fraud pre-check to reduce gateway load.

Recovery is complete when gateway latency is below three hundred milliseconds and the retry queue is empty. Record the gateway error codes and the queue depth over time.`,
  },
];

export const evaluationTickets: EvaluationTicket[] = [
  {
    key: "t_login",
    title: "Login latency spike after release",
    description:
      "p95 login latency rose to four seconds after the last release. Users report slow sign-in on the web app.",
    status: "open",
    priority: "high",
  },
  {
    key: "t_upload",
    title: "Uploads rejected with 413",
    description:
      "Customers cannot upload large attachments. The proxy returns 413 because client_max_body_size is below the documented limit.",
    status: "open",
    priority: "urgent",
  },
  {
    key: "t_quota",
    title: "Disk quota warning on analytics node",
    description:
      "The analytics node is at ninety-two percent disk usage and the temporary spill directory is growing.",
    status: "pending",
    priority: "medium",
  },
  {
    key: "t_webhook",
    title: "Stripe webhook retries delayed",
    description:
      "Webhook deliveries are retried after several minutes, causing delayed subscription state changes.",
    status: "open",
    priority: "high",
  },
  {
    key: "t_search",
    title: "Search returns no results for one tenant",
    description:
      "A tenant reports empty search results after their documents were re-uploaded. Their chunks may not have been indexed.",
    status: "open",
    priority: "medium",
  },
  {
    key: "t_billing",
    title: "Invoice PDF generation timeout",
    description:
      "Monthly invoice PDF generation exceeds the worker timeout and jobs are retried repeatedly.",
    status: "open",
    priority: "high",
  },
];

export const evaluationLogs: EvaluationLog[] = [
  {
    key: "l_pool",
    level: "error",
    message: "connection pool exhausted: too many clients already",
    service: "api",
  },
  {
    key: "l_kafka",
    level: "error",
    message: "kafka consumer lag 450000 on partition checkout-3",
    service: "ingestion",
  },
  {
    key: "l_redis",
    level: "warn",
    message: "redis evicted 12000 keys with policy allkeys-lru",
    service: "cache",
  },
  {
    key: "l_cert",
    level: "warn",
    message: "certificate expires in 7 days for api.example.com",
    service: "edge",
  },
  {
    key: "l_s3",
    level: "error",
    message: "S3 SlowDown 503 on putObject prefix uploads/2026-11",
    service: "storage",
  },
  {
    key: "l_gateway",
    level: "error",
    message: "gateway retry queue depth exceeded 1200 messages",
    service: "checkout",
  },
];

export const evaluationQueries: EvaluationQuery[] = [
  {
    query: "How do we recover from PostgreSQL connection pool exhaustion?",
    relevant: ["d_pg_pool"],
  },
  {
    query: "PGPOOL_MAX environment variable",
    relevant: ["d_pg_pool"],
  },
  {
    query: "PGPOOL_MAX",
    relevant: ["d_pg_pool"],
  },
  {
    query: "KAFKA_LAG_MAX",
    relevant: ["d_kafka"],
  },
  {
    query: "ROLLBACK_DEPLOY",
    relevant: ["d_rollback"],
  },
  {
    query: "CERT_EXPIRY_DAYS",
    relevant: ["d_tls"],
  },
  {
    query: "RATE_LIMIT_BURST",
    relevant: ["d_rate"],
  },
  {
    query: "pg_stat_activity idle in transaction",
    relevant: ["d_pg_pool"],
  },
  {
    query: "evicted keys allkeys lru",
    relevant: ["l_redis"],
  },
  {
    query: "What is the rollback procedure for a failed deployment?",
    relevant: ["d_rollback"],
  },
  {
    query: "KAFKA_LAG_MAX consumer threshold",
    relevant: ["d_kafka"],
  },
  {
    query: "consumer lag keeps growing on checkout partitions",
    relevant: ["d_kafka", "l_kafka"],
  },
  {
    query: "Redis cache hit ratio dropped after eviction",
    relevant: ["d_redis", "l_redis"],
  },
  {
    query: "certificate expires soon for the public API",
    relevant: ["d_tls", "l_cert"],
  },
  {
    query: "S3 SlowDown 503 during large uploads",
    relevant: ["d_s3", "l_s3"],
  },
  {
    query: "checkout fails with 503 when payment gateway times out",
    relevant: ["d_gateway", "l_gateway"],
  },
  {
    query: "who should be paged for a severe incident",
    relevant: ["d_oncall"],
  },
  {
    query: "disable checkout v2 with a feature flag",
    relevant: ["d_flags"],
  },
  {
    query: "restore production database from backup",
    relevant: ["d_backup"],
  },
  {
    query: "rebuild the vector index without downtime",
    relevant: ["d_vector"],
  },
  {
    query: "429 responses from the public API",
    relevant: ["d_rate"],
  },
  {
    query: "upload requests rejected with 413",
    relevant: ["t_upload"],
  },
  {
    query: "XJ-4471",
    relevant: ["d_error_code"],
  },
  {
    query: "settlement currency does not match the ledger",
    relevant: ["d_error_code"],
  },
];
