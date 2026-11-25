# Phase 5.5 — LLM & Embedding Provider Evaluation

**Status:** audit + research + proposed plan. No production default, schema, migration or existing
embedding was changed. Implementation waits for approval (§14).

**Audit date:** 2026-11-24.
**Measured on:** the local `docker compose` stack (`api`, `db` healthy), embeddings served by local
Ollama `nomic-embed-text` (274 MB, 768 d), PostgreSQL 16 + pgvector.

---

## 0. Review corrections applied (approved M0/M1 scope)

### 0.1 The seven corrections

| # | Point raised | Where it changed the plan |
| --- | --- | --- |
| 1 | In-place backfill destroys the nomic vectors, so reverting the env cannot restore retrieval | §11.2 rebuilt around a **staging table** (production untouched) plus a **backup snapshot**; §11.3 now defines a complete, tested data rollback instead of a config-only one |
| 2 | Do not enable Groq fallback before evaluating it | Fallback ships **disabled** (`LLM_FALLBACK_ENABLED=false`); enabling is gated on M3 (§9, §10.1) |
| 3 | One interface for text and structured JSON; no `generateJson()` for prose | The shipped interface is one `generate(request)` with `responseFormat: "text" | "json"` (§10.1) |
| 4 | Hard technical retrieval cases, keep the corpus and the keyword arm | §5.2 now specifies concrete cases (stack traces, abbreviations, unfamiliar terminology, paraphrases, cross-source) and requires the keyword contribution to be reported, not just preserved |
| 5 | Partial migration must not create retrieval gaps; rehearse rollback | §11.2 removes the gap by construction; §11.4 states the invariants, §11.3 makes a scratch-database rehearsal a milestone |
| 6 | Record the provider/model that actually generated each analysis and follow-up | Implemented in M1: `analysis.provider` returns the answering provider, the row is updated with it, follow-ups record it (§10.2) |
| 7 | Distinguish unpaid-tier privacy per provider; send no sensitive data | §8.1 privacy matrix and an evaluation-data rule (§8.2) |

### 0.2 M1 status: implemented, default behaviour unchanged

`apps/api/src/modules/ai/llm/` holds one generation client used by both call sites:

- `provider.ts` — `GenerateRequest` / `LlmResult` / `LlmProvider`, one method: `generate()`.
- `gemini.provider.ts` — the existing `generateContent` call, now with usage capture and retries.
- `openai.provider.ts` — `POST {LLM_BASE_URL}/chat/completions` (Groq/Cerebras/OpenRouter/llama.cpp).
- `retry.ts` — `Retry-After`, exponential backoff with jitter, and a `RetryableTimeout` so an exhausted
timeout still maps to **504**, not 502.
- `settings.ts` / `index.ts` — env reading, provider factory, opt-in fallback, sanitized logging.
- `providers.test.ts` — 17 tests against local stub servers (no network, no key, no quota).

Behaviour on an unmodified environment is unchanged: `LLM_PROVIDER` defaults to `gemini`, model precedence
is `<FEATURE>_LLM_MODEL` → `LLM_MODEL` → `GEMINI_MODEL` → `gemini-2.5-flash-lite`, RAG still sends
`temperature 0.1 / topP 0.8 / maxOutputTokens 700` with **no** JSON MIME type, analysis still sends
`0.2 / 0.9 / 1600` with `responseMimeType: application/json`, and `RAGProviderError` (502) /
`RAGProviderTimeoutError` (504) remain the endpoint contract.

Attribution now comes from the result, never from a constant: `investigation_analyses.provider`,
`.model` and the follow-up activity metadata are written from `result.provider` / `result.model`, and the
row is updated again on success in case a fallback answered.

### 0.3 Verification actually run

`npm run typecheck` → clean. `npm test` → **276/276 pass** (234 before + 42 new). Configuration
failures are mapped to the endpoint's 502 on all three generation paths, including an unknown
`LLM_PROVIDER`, which is read before the generation call and therefore needed its own mapping. A
configuration 502 keeps its message instead of the generic `Internal server error`: `RAGProviderConfigError`
subclasses `RAGProviderError` (so the status mapping is unchanged) and sits on the error middleware's
explained-server-error allowlist, whose messages name environment variables and never values.

End-to-end against a stub provider (real PostgreSQL, real `nomic-embed-text` ingestion, **zero** provider
quota; `GEMINI_API_KEY` is unset in this environment, so a live Google call was not possible):

```
step: indexing document (real embeddings)      chunkCount 1, embeddingModel nomic-embed-text
PASS /ai/ask                                   jsonMode=false, 1 source, prompt 1 643 chars
PASS analysis                                  provider=gemini model=gemini-2.5-flash-lite,
                                               summary persisted, 1 hypothesis, 1 citation
PASS follow-up                                 provider=gemini model=gemini-2.5-flash-lite, 1 citation
stub requests [{jsonMode:false},{jsonMode:true},{jsonMode:true}]
VERIFIED
```

That the RAG request carried **no** `responseMimeType` while both structured calls did is the specific
regression this phase had to avoid.

Re-verified over HTTP against the **rebuilt container** with no LLM key set, so the real configuration path
answered rather than a stub:

```
POST /ai/ask                          502  GEMINI_API_KEY is required to generate an answer
POST /investigations/:id/analyze      502  GEMINI_API_KEY is required to generate an answer
POST /investigations/:id/questions    502  GEMINI_API_KEY is required to generate an answer
GET  /investigations/:id/analysis     200  status=failed
                                           failure=GEMINI_API_KEY is required to generate an answer
```

### 0.4 Still open before M3

- **Record the real Gemini free-tier limits** (RPM/RPD/TPM) from AI Studio → Rate limits. Google no longer
publishes them statically, so §7/§12 numbers stay marked *(unverified)* until someone with the project open
reads them. This is a one-minute manual step and it blocks the capacity claims, not the code.
- `ANALYSIS_LLM_MODEL=gemini-2.5-flash` is deliberately **not** set yet: changing the analysis model is a
quality decision that M3 measures.
- Nothing is deployed to a shared environment; the local `api` container was rebuilt from this worktree
  (see §0.5).
- M2's harness exists and is verified by replay; its first real `--record` sweep is M3 and needs a key.

### 0.5 Environment note

The `api` container bakes its source at build time (only `uploads`/`pgdata` are volumes), so any source change
needs a rebuild before the container reflects it. It has been rebuilt and restarted from this worktree, which is
what the configuration-502 check above ran against. The stub-provider run used the host worktree pointed at the
published database. `web`, `worker` and the database were not redeployed — the worker still needs the same
rebuild before it runs the new generation code.

---

## 1. Current AI architecture assessment

### 1.1 What actually exists (and where the brief is out of date)

| Claim in the brief | Reality in the repository |
| --- | --- |
| LLM: Gemini 2.5 **Flash** | Default is **`gemini-2.5-flash-lite`** — `analysis.provider.ts:19` and `rag.service.ts:18`, `DEFAULT_GEMINI_MODEL`. `GEMINI_MODEL` overrides it. |
| "An AI provider abstraction" | **Embeddings only.** There is a real `EmbeddingProvider` interface with three implementations. Generation has **no** abstraction: Gemini is called directly by axios in two places (`rag.service.ts:generateAnswer`, `analysis.provider.ts:generateJsonResponse`), with duplicated key handling, retry-free error mapping and model naming. |
| Embeddings: Ollama `nomic-embed-text` | Correct, and it is the env default (`EMBEDDING_PROVIDER=ollama`). |
| Embedding model/dimension tracking | Correct and unusually good — see §1.2. |
| Retrieval / investigation eval harnesses | Correct: `eval:retrieval`, `eval:investigations`. Both were **run** for this report (§5.1, §6.1). |
| Recorded embedding fixtures used by CI | Correct: `src/evaluation/embeddingFixtures.json` + `embeddingFixtureServer.ts` replay, never a hash fake. |

### 1.2 Embedding layer — already the right shape

- `EmbeddingProvider` (`embedding/provider.ts`) exposes `model`, `dimensions`, `endpoint`, `embed()`, `probe()`.
- Providers: `ollama`, `openai-compatible` (any `POST {BASE_URL}/embeddings`), `fixture` (recorded replay).
- **Vector-space safety is already enforced at the SQL level**, not by convention:
  `vector.service.ts` filters `embedding_model = $5 AND embedding_dimensions = $6` before ordering by
  cosine distance. A query vector from model B can therefore never be compared with model-A rows —
  they are not in the result set. This is the single most important property to preserve.
- `source_chunks` records `embedding_model`, `embedding_dimensions` (migration `0003`), and the column is
  `VECTOR(768)` (migration `0001`), so **any candidate model must be able to emit 768 dims** or the
  schema has to change.
- Ingestion identity: `getEmbeddingConfig()` derives `{model, dimensions, hash}` from the provider that
  actually produced the vectors, and jobs store `embedding_config_hash` — so a model change invalidates
  reuse decisions correctly instead of silently keeping stale vectors.

### 1.3 Generation layer — needs consolidation, not replacement

- `rag.service.ts` builds a well-hardened grounded prompt: context wrapped in `<context>` tags declared as
  data-not-instructions, "answer exactly `No reliable operational context found.`" when insufficient,
  inline source-number citations, `temperature 0.1`.
- `analysisPolicy.ts` / `followUpPolicy.ts` build `E1..En`-labelled evidence prompts and then **distrust the
  model completely**: every field type-checked, every list capped, every invented citation dropped
  (`resolveEvidenceCitations`), responses >20 000 chars rejected.
- Consequently most "structured output reliability" risk is already absorbed by the parser. What the
  parser cannot absorb is *semantically* wrong JSON: a valid object with an invented cause.

### 1.4 Configuration surface today

Generation: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_API_BASE_URL`, `RAG_MAX_OUTPUT_TOKENS`,
`ANALYSIS_MAX_OUTPUT_TOKENS`. Embeddings: `EMBEDDING_PROVIDER|MODEL|DIMENSIONS|BASE_URL|API_KEY|
SEND_DIMENSIONS|FIXTURE_PATH`, `OLLAMA_URL`, `OLLAMA_EMBEDDING_MODEL`.

**Missing for a hosted deployment:** no timeout/retry policy for 429s on generation, no fallback provider,
no per-provider key separation for generation (only one), and `ANALYSIS_PROVIDER` is a hardcoded constant
`"gemini"` written into `investigation_analyses.provider` — so it would lie about the model after any
provider change.

### 1.5 Retrieval tuning values are model-specific (a hidden migration risk)

`AI_SEARCH_MIN_SIMILARITY=0.65` (clamped in `retrieval.service.ts`), and `estimateConfidence()`'s
`0.88 / 0.80` and `0.78 / 0.75` thresholds, are calibrated against **nomic-embed-text's** similarity
distribution. Cosine similarity is not comparable across models: cloud embedding models typically produce
a different spread (often higher baseline similarity for unrelated text). Changing the embedding model
**without recalibrating these numbers silently degrades recall or inflates confidence**. This is not in the
brief and should gate the migration (§11).

---

## 2. LLM provider comparison

Numbers are from official pages where the researcher could read them; anything not verifiable from a
first-party page is marked **(unverified)**. Free tiers change without notice — re-check at implementation
time.

| | Gemini API (current) | Groq | Cerebras | OpenRouter |
| --- | --- | --- | --- | --- |
| Card required for free use | No | No (card only to upgrade to Developer) | **Yes** — $5 trial credits need a verified payment method | No (base allowance) |
| Free model of interest | `gemini-2.5-flash`, `gemini-2.5-flash-lite` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | `gpt-oss-120b` | `:free` rotating pool |
| Free RPM / RPD / TPM / TPD | Not published statically; per-project, read in AI Studio **(unverified)** | 30 RPM / 1 000 RPD / 8 000 TPM / 200 000 TPD | 5 RPM / 30 000 TPM, 1 M TPD (trial, card-gated) | 20 RPM / 50 RPD **without** any credit purchase; 1 000 RPD after ≥$10 lifetime purchase |
| Context | 1 M tokens (Flash/Flash-Lite) | 131 072 | 65 536 on free tier (131 072 paid) | per model |
| Strict JSON schema | Subset of JSON Schema via `responseSchema` | `strict: true` constrained decoding for gpt-oss | `strict: true` documented | not guaranteed |
| Tool calling | Yes | Yes (not combined with structured outputs) | Yes | model-dependent |
| Data retention | Free tier: inputs **and outputs** used to improve Google products; human reviewers may read them | Not retained by default; not used for training unless permitted | trial terms | provider-dependent per model |
| Independent RAG-faithfulness signal | Vectara FaithJudge: **6.26 %** overall hallucination for 2.5 Flash; 2.88 % RAGTruth QA | Vectara HHEM: **14.2 %** for gpt-oss-120b (summarisation consistency) | — | — |
| Long-context reliability signal | MRCR v2: Flash 54 % @128K, 32 % @1M; Flash-Lite 12 % @128K, 6.5 % @1M | — | — | — |
| Verdict | Best quality evidence + roomiest quota | Best cheap fallback; TPM is the binding limit | **Disqualified** (card) | Fallback of last resort; 50 RPD is too small for the investigation workflow |

Sources: `ai.google.dev/gemini-api/docs/pricing`, `.../rate-limits`, `.../structured-output`,
`ai.google.dev/gemini-api/terms`, `console.groq.com/docs/rate-limits`, `.../models`, `.../your-data`,
`.../docs/structured-outputs`, `inference-docs.cerebras.ai/support/rate-limits`,
`openrouter.ai/docs/api_reference/limits`, `github.com/vectara/FaithJudge`,
`github.com/vectara/hallucination-leaderboard`, Google Flash / Flash-Lite model cards.

**What the benchmarks do and do not prove.** Gemini 2.5 Flash has the only RAG-specific
faithfulness evidence among the candidates (2.88 % on RAGTruth QA, 6.26 % overall). `gpt-oss-120b`'s
14.2 % figure is document-summarisation consistency, a different task, so it is a warning, not a verdict.
There is **no** published benchmark for multi-source root-cause reasoning across conflicting evidence —
which is exactly OpsPilot's hardest job, and the reason §4 exists.

**Do not assume parameter count wins.** `gpt-oss-120b` is ~4× larger than `gemini-2.5-flash-lite` in
parameters yet scores worse on the only comparable faithfulness measurement, and its Groq free-tier TPM
(8 000) is 1–2 prompts per minute at OpsPilot's prompt sizes.

---

## 3. Embedding provider comparison

| | nomic-embed-text (current) | Gemini `gemini-embedding-001` | Voyage `voyage-4-lite` / `voyage-code-3` | Jina `v5-text-small` | Cohere trial | Cloudflare `bge-m3` |
| --- | --- | --- | --- | --- | --- | --- |
| Hosting | **local Ollama** | cloud | cloud | cloud | cloud | cloud |
| 768 dims | native | **yes** (`output_dimensionality`) | 512/1024/2048 — **not 768** | 1024, MRL-truncatable but not to 768 by documented steps | 768 supported | 1024 |
| Free allowance | unlimited (your CPU) | free tier, $0 (paid $0.15/M tok) | **200 M tokens once** (voyage-4 family / code-3) | 10 M tokens once + 500 RPM / 1 M TPM | trial: 1 000 calls/month, **non-commercial only** | 10 000 neurons/day |
| Card | n/a | no | no for free tokens | no (implied) | no | no |
| Max input | 8 192 tok | 2 048 tok (`-001`), 8 192 (`-2`) | 32 000 tok | 32 000 tok | 128 000 tok | 60 000 tok |
| Task instructions | none | `task_type=RETRIEVAL_DOCUMENT/QUERY` | `input_type=query/document` | `retrieval.query/passage`, `code.*` | `search_document/query` | `query` vs `contexts` |
| Batch | 16/request (our client) | `batchEmbedContents`, 100/request; async Batch API is **paid-only** | 1 000 texts, 320 K–1 M tok/call | 10 000 inline | 96 texts | 100 items |
| Data terms | local | free tier: used to improve Google products; paid tier: not | **unverified** | **unverified** | trial data used for R&D | explicit **zero data retention** |
| Schema impact | none | **none** (768 fits `VECTOR(768)`) | requires `VECTOR(1024)` + reindex | requires `VECTOR(1024)` | none | requires `VECTOR(1024)` |

Sources: `ai.google.dev/gemini-api/docs/embeddings`, `.../pricing`, `docs.voyageai.com/docs/pricing`,
`.../embeddings`, `.../rate-limits`, `docs.jina.ai/api.md`, `docs.cohere.com/docs/rate-limits`,
`developers.cloudflare.com/workers-ai/models/bge-m3`, `.../platform/pricing`.

**Knock-out reasoning**

- **Voyage** has the most generous raw allowance (200 M tokens ≈ 400× the whole demo corpus) and excellent
  code/log behaviour (`voyage-code-3`), but no 768-dim option → `VECTOR(1024)` migration, HNSW rebuild,
  and a one-time-not-renewing quota. Keep as the quality benchmark to beat, not the default.
- **Cohere** trial keys are contractually non-commercial — unusable for a public portfolio app.
- **Jina** dims and MRL steps don't land on 768 cleanly, and privacy terms are unverified.
- **Cloudflare `bge-m3`** has the best privacy terms (explicit ZDR) but 1024 dims and a 10 000 neuron/day
  budget that is hard to predict per token.
- **Gemini `gemini-embedding-001` at 768** is the only candidate that is free, card-free, 768-native,
  retrieval-task-aware, and multilingual — i.e. **zero schema change**. Its weak points: 2 048-token input
  cap (fine — chunks are ≤400 tokens) and free-tier data use (§8).

> Caveat on Matryoshka: Google documents that non-3072 outputs from `gemini-embedding-001` must be
> L2-normalised by the caller. For **cosine** distance this is ranking-neutral (pgvector and the HNSW
> `vector_cosine_ops` index are magnitude-invariant), so it does not affect recall here; normalise anyway so
> stored vectors are comparable with an inner-product index if one is ever added.

---

## 4. LLM evaluation dataset and methodology

### 4.1 Design constraints

- Synthetic/sanitised only. The corpus in `retrievalDataset.ts` + `investigationDataset.ts` is already
  synthetic and already used by CI — reuse it so evidence, labels and expected answers stay in one place.
- **Deterministic first.** The existing parsers already reject malformed output; the harness must measure
  what the parser *cannot* catch: invented entities, invented numbers, unsupported causes.
- Human review on a fixed subset, so the score is auditable without an LLM judge.
- An LLM judge is optional and only ever reported alongside the deterministic score.

### 4.2 Scenario matrix (24 cases)

Six cases are fully worked examples; the rest follow the same shape and are specified by ID, input and
assertions. Every case stores: `prompt_input`, `expected_facts[]`, `allowed_numbers[]`,
`forbidden_entities[]`, `must_be_insufficient` (bool), and `required_citations[]`.

| # | Scenario | Input | Deterministic assertions |
| --- | --- | --- | --- |
| L1 | Explain an error from logs | `log: "connection pool exhausted: too many clients already"` + ticket about login latency | Must name *connection pool saturation*; must **not** name Kafka/Redis/cert (absent from evidence) |
| L2 | Root cause from multiple sources | pool runbook + `too many clients` log + login-latency ticket | Root cause = exhausted pool; `d_pg_pool` and `l_pool` both cited; symptom ("slow login") separated from cause |
| L3 | Symptoms vs root cause | gateway timeout runbook + retry-queue-depth log | Must classify `503` and queue growth as symptoms, `gateway call timeout` as cause |
| L4 | Investigation summary | 12 mixed evidence rows (investigation fixture) | Every sentence's entities ⊆ evidence entities; 3–6 observations; no timestamps not present |
| L5 | Hypotheses with support/contradiction | Evidence where the log *supports* pool exhaustion but the deploy timeline *contradicts* it | ≥1 hypothesis with non-empty `supports` **and** one with non-empty `contradicts`; no hypothesis cites the same label in both lists (parser already forbids) |
| L6 | Follow-up Q using analysis context | Investigation context + "was it deployed before or after the errors?" | Answer must use the two timestamps from context; `insufficient_context=false` |
| L7 | Citation accuracy | Any L2 evidence set | `E`-labels resolve; every claim sentence carries a bracket label; dropped-citation count = 0 |
| L8 | Refuse when insufficient | Empty evidence / unrelated evidence (the `no-matching-evidence` case) | `insufficient_evidence=true` (or the exact `No reliable operational context found.` string for RAG); **zero** invented service names |
| L9 | Valid structured JSON | All 24 cases | `JSON.stringify(parse())` succeeds; no code fence; every required key present; list caps respected |
| L10 | Instruction adherence | L4 with an extra constraint: "do not recommend restarting the process" | Recommendation list must not contain restart/power-cycle verbs; must still be non-empty |
| L11 | Numeric fidelity | Runbook numbers (`20` connections, `five minutes`, `30s` TTL) | Every number in output ∈ `allowed_numbers` (regex `\b\d+([.:]\d+)?\b`) |
| L12 | Long-context stress | L2 with 10 of 12 evidence slots filled by distractors | Correct source still cited; no distractor cited |

### 4.3 Metrics

| Metric | How it is computed | Judge needed? |
| --- | --- | --- |
| JSON validity | parse succeeds (existing parser) | no |
| Schema conformance | all required keys, types, caps | no |
| Citation validity | Σ `droppedCitations` across cases (0 ideal) | no |
| Citation precision | cited labels whose excerpt actually contains a `required_citations` token | no |
| Numeric fidelity | hallucinated-number rate = invented numbers / total numbers | no |
| Entity hallucination | count of `forbidden_entities` occurrences | no |
| Refusal correctness | L8 passes + false-refusal rate on L1–L7 | no |
| Constraint adherence | L10 + "JSON only" checks | no |
| Root-cause quality | rubric 0–3 on 6 cases, by hand | partial |
| Completeness | rubric 0–3: are all labelled expected facts present? | partial |
| Latency | wall clock p50/p95 per provider | no |
| Token consumption | provider `usage` block; fall back to our `estimateTokens` | no |
| Judge agreement | optional LLM judge vs human rubric, report Cohen's κ | optional |

**Hallucination rate** is reported as `(cases with ≥1 failed deterministic check) / cases`, plus the
citation and numeric sub-rates. Never collapse them into one "quality" number.

### 4.4 Quota discipline (important)

A full 24-case sweep is ≈ 24 × (4 000 in + 900 out) ≈ **118 K tokens**. That is:
- ~12 % of Groq's daily 200 K TPD — one sweep per day per Groq model, and only if nothing else runs;
- comfortably inside Gemini's free RPD quota **(unverified count, but token-limited tiers are not the
  constraint there)**.

Therefore: **run the sweep on Gemini first (baseline), then one confirmation sweep per Groq/Cerebras-family
candidate**, never the reverse. Do not run a sweep, a retry and a re-score on the same day against Groq.
The harness must therefore cache raw responses to disk (`eval/llm-runs/<date>/<provider>/<case>.json`) and
score offline — re-scoring must never re-spend quota.

---

## 5. Embedding evaluation results

### 5.1 Measured baseline — `nomic-embed-text`, run 2026-11-24

Command (inside the `api` container, local Ollama, zero quota, ephemeral org deleted by the harness):

```
docker compose exec -T api npx tsx src/scripts/evaluateRetrieval.ts
```

Corpus: **32 documents (18 distractors), 6 tickets, 6 log events, 36 queries**, 768 d, `VECTOR(768)`.

| Mode | Recall@5 | Recall@10 | Precision@5 | Precision@10 | MRR@10 | nDCG@10 | KW-only@10 | KW-only wrong@10 | Avg ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vector | 0.8796 | 0.8796 | 0.2333 | 0.1167 | 0.9306 | 0.8866 | 0.00 | 0.00 | 61 |
| hybrid (RRF) | **0.9907** | **0.9907** | 0.2722 | 0.1361 | **0.9861** | **0.9801** | 2.75 | 2.56 | 36 |

Observations that matter for model selection:

1. **Hybrid is already near-saturated.** Recall@10 = 0.9907 means only one query misses anything at all
   (`large uploads are either throttled or rejected by the body size limit` — `l_s3` is missed by both
   arms). A new embedding model has ~1 % of headroom on recall.
2. **Precision@K is structurally capped**, not a quality problem: max P@5 = |relevant|/5, and 30 of 36
   queries have 1–2 relevant sources. Compare precision only against the same corpus.
3. **The discriminating metrics are MRR@10 and nDCG@10**, plus a harder query set (§5.2). Selection on
   Recall@10 alone would be noise.
4. **Hybrid latency is dominated by Ollama on the host** (30–160 ms per query embedding). This number says
   nothing about a cloud provider; cloud latency must be measured separately (§5.3).
5. Vector-only misses 4 queries outright (`PGPOOL_MAX environment variable`, `429 responses…`), which the
   keyword arm rescues — the RRF fusion is doing real work. **No embedding change may be allowed to reduce
   the keyword arm's contribution.**

### 5.2 Harness upgrade needed before candidate comparison

The current harness cannot discriminate between two good models (ceiling), and it is single-mode. Proposed
additive changes to `evaluateRetrieval.ts` (no change to app behaviour):

1. `--provider <name>` / `--model <id>`: seed and query **one provider per run into its own ephemeral
   organisation**, so a run can never mix vector spaces even by accident (belt-and-braces on top of the
   `embedding_model` filter).
2. `--queries hard`: a held-out set (below) that does not reuse the corpus's own vocabulary. This is where a
   stronger model should separate from nomic.
3. `--json out.json`: write the payload (the harness already emits `EVAL_JSON=` for this).
4. Report **per-source-type** recall (documents / tickets / log groups) — the three families embed very
   differently for a cloud model.
5. Record **similarity distribution** (p10/p50/p90 of the top hit's similarity) per provider, because
   `AI_SEARCH_MIN_SIMILARITY` must be recalibrated from it.
6. Record throughput (`chunks/sec`, batch size 16) and 429/retry counts from the provider.
7. **Report the keyword arm separately**, not just the fused result: `recall@K` of the hybrid mode with the
   keyword arm's contribution counted, so a candidate that wins on vectors but loses on identifiers is not
   declared the winner. The existing 36-query set stays exactly as it is (the numbers in §5.1 must stay
   reproducible); the hard set is additive.

**Hard set (12 queries).** Each is scored against the same labelled sources, so the metrics are directly
comparable with §5.1.

| # | Kind | Query | Relevant | Why it is hard |
| --- | --- | --- | --- | --- |
| H1 | Unfamiliar terminology | "sessions are being silently dropped when the box runs out of room" | `d_redis` | never says Redis, cache or eviction |
| H2 | Stack trace | `Error: remaining connection slots are reserved for non-replication superuser connections at PG.connect` | `d_pg_pool`, `l_pool` | the runbook never quotes the driver frame |
| H3 | Abbreviation (expanded) | "maximum number of pooled clients per server instance" | `d_pg_pool` | expands `PGPOOL_MAX` instead of naming it |
| H4 | Abbreviation (ambiguous) | "TLS SNI cert rollover" | `d_tls`, `l_cert` | two abbreviations, neither in the text |
| H5 | Paraphrase | "our event consumers have fallen behind the producers" | `d_kafka`, `l_kafka` | no "lag", no "partition" |
| H6 | Paraphrase + distractor | "uploads are being rate limited by the bucket but the file is also too big" | `d_s3`, `l_s3`, `t_upload` | mixes two causes that live in three sources |
| H7 | Cross-source | "did the release cause the slow logins or was the database already saturated" | `d_pg_pool`, `l_pool`, `t_login` | needs runbook + log + ticket together |
| H8 | Cross-source | "checkout failures and delayed subscription updates, same root cause?" | `d_gateway`, `l_gateway`, `t_webhook` | three sources, one cause |
| H9 | Log group | "repeated image pull failures after the deploy" | `l_*` (deploy corpus) | log-group embedding, not prose |
| H10 | Ticket style | "customer says search returns nothing after re-upload" | `t_search` | terse, no operational vocabulary |
| H11 | Numeric | "what happens at twenty-one days before expiry" | `d_tls` | number only appears as `CERT_EXPIRY_DAYS` threshold |
| H12 | Negative | "how do we scale the kubernetes node pool" | `n_k8s_nodepool` | correct answer is a distractor; catches a model that only matches surface words |

H12 is deliberate: a candidate that scores 0 on it is behaving correctly, and the harness reports it
alongside the others rather than folding it into an average.

#### 5.2.1 Implemented (M5) — and the baseline still reproduces

```bash
npm run eval:retrieval                                         # the 36-query set, unchanged
npm run eval:retrieval -- --queries hard                       # the 12 held-out queries
npm run eval:retrieval -- --provider gemini --model gemini-embedding-001
npm run eval:retrieval -- --json .eval/retrieval.json
```

- `--provider` / `--model` set `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` **before** the provider is built (it
  is cached for the process), and the ephemeral organization is now named after the embedder
  (`Retrieval Evaluation (ephemeral) ollama/nomic-embed-text`). Two models therefore cannot share vectors even
  if the SQL model filter were ever relaxed.
- `--queries hard` swaps in `hardEvaluationQueries`; the 36-query set, the corpus and the scoring are untouched.
  One query is substituted: the published H9 ("repeated image pull failures") needs a deploy log group this
  corpus does not have, and adding one would move the §5.1 counts, so it is "repeated key evictions since the
  deploy" against `l_redis`.
- Every run reports recall@10 split by source type and the top hit's similarity p10/p50/p90 per mode, and
  `--json <path>` writes the whole payload (provider, model, dimensions, config hash, query set, corpus counts,
  summary, similarity, per-type recall, per-query rankings). An unknown flag exits 1, so a typo cannot silently
  run the default set.

Measured on `nomic-embed-text`, 2026-11-25 (`.eval/retrieval-baseline.json`, `.eval/retrieval-hard.json`):

| Set | Mode | Recall@10 | MRR@10 | nDCG@10 | KW-only@10 | Top-hit sim p10 / p50 / p90 | docs @10 | tickets @10 | logs @10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| standard (36) | vector | 0.8796 | 0.9306 | 0.8866 | 0.00 | 0.6926 / 0.7730 / 0.8443 | 0.9394 | 0.8333 | 0.5455 |
| standard (36) | hybrid | 0.9907 | 0.9861 | 0.9792 | 2.75 | 0.6926 / 0.7730 / 0.8443 | 1.0000 | 1.0000 | 0.9091 |
| hard (12) | vector | 0.5139 | 0.6667 | 0.5511 | 0.00 | 0.6749 / 0.7182 / 0.7715 | 0.6000 | 1.0000 | 0.0000 |
| hard (12) | hybrid | **0.9028** | **0.9583** | **0.8901** | 2.83 | 0.6749 / 0.7182 / 0.7715 | 1.0000 | 1.0000 | 0.5714 |

The hard set does what §5.2 asked of it: vector-only recall falls from 0.88 to 0.51 while hybrid holds at 0.90,
so there is now 0.39 of headroom in which a better embedder can separate -- and log groups are where the keyword
arm earns its place (vector 0.00, hybrid 0.57).

**Reproduction note.** Recall, precision, MRR and the per-type numbers reproduce §5.1 exactly. Hybrid nDCG reads
0.9792 against the recorded 0.9801: in the gateway query `l_gateway` lands at rank 4 instead of 3, and the
top-hit similarity distribution matches to four decimals, so the embeddings are the same and this is rank
ordering beyond the scored items. Two more queries swap two non-relevant extras in the same way (equal RRF ranks
between keyword-only candidates), which predates this change -- the harness only applies the same ranking and
reports it. A deterministic tie-break would fix the ordering but changes app behaviour, so it is not in M5.

### 5.3 Candidate results

**Untested.** No cloud embedding call was made: there is no API key in this repository and §9 of the brief
forbids quota-consuming experiments before approval. The exact protocol above is what produces the numbers;
§5.1 is the baseline those numbers will be compared against. Reporting a recall figure for a model that was
never run would be fabrication.

Expected-cost disclosure for the sweep: the whole corpus is ≈ 32 docs + 6 tickets + 6 log groups ≈ **210
chunks ≈ 60 K tokens per provider per mode**, plus 36 query embeddings × 3 queries-set variants. One provider
run is < 100 K tokens — inside every candidate's free monthly allowance, and ~0.05 % of Voyage's one-time
200 M grant. This is a cheap experiment; it is deferred only because the brief puts an approval gate first.

---

## 6. Quality comparison against current baselines

### 6.1 Deterministic investigation evidence — measured, PASS

```
docker compose exec -T api npx tsx src/scripts/evaluateInvestigations.ts
```

```
cases 5 · positiveCases 4 · recall 1.00 · precision 1.00 · gradingAccuracy 1.00
selected 11 · extras 0 · duplicateViolations 0 · forbiddenHits 0
emptyCaseViolations 0 · windowFailures 0 · manualLinks 1 · meanLatencyMs 138
Thresholds: PASS
```

This harness deliberately calls **no** language model, so it is the correct regression gate for the
embedding migration: if a candidate model breaks evidence collection, this job fails before any LLM is
involved. It must keep passing after the migration, unchanged.

### 6.2 Generation quality — first measured sweep (M2 harness; M3 partial)

Before M2 this section said "unmeasured", and that was the honest answer: CI deliberately does not score
generated text. `npm run eval:llm` now records raw responses once and scores them deterministically, reusing the
production parsers, so the numbers below are of the code that actually runs. First real sweeps, 2026-11-24:

- `qwen2.5:3b-instruct` on the host's Ollama through the OpenAI-compatible provider — 24/24 cases, free, local.
- `gemini-2.5-flash-lite` — 20/24 cases; the free-tier daily quota stopped the sweep at case 20 (below).

| Metric | qwen2.5:3b-instruct (24) | gemini-2.5-flash-lite (20) |
| --- | --- | --- |
| parsed / schema valid | 1.000 / 1.000 | 1.000 / 1.000 |
| fact coverage | 0.826 | 0.850 |
| citation precision | 1.000 | 1.000 |
| hallucination rate | 0.083 (2 cases) | 0.050 (1 case) |
| refusal accuracy | 0.500 (2 of 4) | 0.667 (2 of 3) |
| constraint violations | 0 | 0 |
| dropped citations / invented numbers | 0 / 0 | 0 / 0 |
| latency mean / p95 | 7.0 s / 10.4 s | 3.9 s / 22.4 s |
| tokens in / out | 11 988 / 5 721 | 10 236 / 8 223 |

Both models produced valid JSON and structurally acceptable analyses on every case, including the 3B local one.
What separates them is not format but judgement, and after the instrument was corrected (below) **every
remaining failure is the model's**:

- `l8-refuse-when-evidence-is-unrelated` — **both** models answered with a cause even though the linked evidence
  was a website copy brief and an onboarding checklist. They produced load/symptom explanations instead of
  setting `insufficient_evidence`. This is the failure mode the case exists to catch, and it is the single most
  important number here: a confident answer built on unrelated evidence is worse than "I cannot tell".
  **Fixed in both prompts after this sweep — see §6.2.1.**
- `l6-follow-up-with-context` — `qwen2.5:3b` refused a question the evidence answers (image pull failure at
  09:58, failed promotion at 10:03). `gemini-2.5-flash-lite` answered it correctly from the timestamps. A
  small-model limitation, not a prompt defect.

#### The first sweep's flags were mostly the scorer's fault

The initial pass flagged six cases on qwen and five on flash-lite. Reading each one against its evidence showed
four distinct **instrument** defects, all fixed in the harness rather than by relaxing the score:

| Flag | Cause | Verdict |
| --- | --- | --- |
| `l4`, `l10`, `g2` | "12,000" / "450,000" vs evidence "12000" / "450000" | false positive — thousands separators |
| `l1` | "500" repeated from the investigation description, which the prompt contains | false positive — allowed-number set too narrow |
| `g1`, `g2`, `g4` (flash-lite) | cited as `[1]`, not `Source 1` / `E1` | false positive — citation spelling |
| `l6` (flash-lite) | quoted the full ISO timestamp; `58:00` was read as a number | false positive — colon treated as a decimal separator |
| `l6`, `l8` (remaining) | see above | **real model defects** |

Hallucination rate fell from **0.250 to 0.083** (qwen, 24 cases) and **0.250 to 0.050** (flash-lite, 20 cases)
once the instrument was right, with invented numbers going 8 → 0. This is the argument for keeping the harness:
a scorer that punishes formatting is worse than no scorer, because the two real failures were buried in six.

#### 6.2.1 The unrelated-evidence gate

The prompts already said "if the evidence cannot support a cause, set `insufficient_evidence` to true", and both
models ignored it on `l8`. The instruction was too weak for what it asked: the opening line said "explain the
most likely cause", so a model that can always produce a cause always will. Both prompts now open with a
relevance decision instead — evidence relates when it shares a system, service, error or timestamp with the
investigation, or states the same symptom, and "related but inconclusive is still evidence: analyse it" — and
both reserve the insufficient flag for the case where nothing relates at all.

The declaration is also now structural, not cosmetic: `parseAnalysisResponse` empties `hypotheses` whenever
`insufficient_evidence` is true, because a stored cause next to a stored disclaimer is the exact output the
case exists to reject.

The first wording of this gate fixed `l8` and then lost two neighbouring cases to prompt text, not to the model.
`l7` stopped citing `E1` because the rules said "a hypothesis without supporting evidence is allowed; leave
supports empty" two lines above "cite the labels each hypothesis rests on" — a contradiction a small model
settles by citing nothing. `a3-kafka-lag-triage` refused although its log line repeats the investigation's error
signature verbatim, because "explains the described symptom" read as "must explain the cause". Merging the three
citation rules into one, and saying that stating the symptom is enough, recovered both. A harder version of the
same idea ("if even one item matches, the flag must be false") was also tried and re-broke `l8`, so it is not in
the prompt: the model still has to judge relatedness, and a gate the model can fail is the only one worth having.

Re-recorded 24/24 on `qwen2.5:3b-instruct` after the change (`.eval/llm-runs/ollama-qwen25-3b-gate4`):

| Metric | before the gate | gate, first wording | final |
| --- | --- | --- | --- |
| `l8` refusal | cause from a copy brief | correct | correct |
| `a3` over-refusal | none | refused its own error signature | answered, 2/2 facts |
| hallucination rate | 0.083 | 0.083 | **0.000** |
| insufficiency decisions correct | 3 of 5 | 3 of 5 | **3 of 3** |
| citation precision | 1.000 | 0.958 | 1.000 |
| fact coverage | 0.826 | 0.785 | 0.722 |
| invented numbers | 0 | 0 | 0 |

The insufficiency denominator grows whenever the model refuses, so 3 of 5 and 3 of 3 are the same score over
different decisions: the final prompt makes no false refusals and misses none (`l8`, `l9`, `f3` all correct, `l6`
and `a3` no longer refuse).

The remaining cost is fact coverage, and it is real: `l3-symptom-vs-cause`, `a4-s3-throttling-cause` and
`l6-follow-up-with-context` each leave out one required detail the pre-gate run stated, while `l1` gained one
(and `l7` now cites its evidence but still omits the recommendation). Nothing is invented in their place, which
is why hallucination reads 0.000. On 24 cases with a 3B model this is what the gate buys: safety up, completeness
down. It is a prompt-shaped trade, so a capable model may not pay it — unmeasured until the quota resets.

The obvious next step was tried and rejected. Two lines — "name the cause, not its symptom, and say what the
evidence rules out", and "when the question asks about order or timing, quote the timestamps" — recovered `a4`
(2/2) and got `l6`'s ordering right, but re-broke `a3` (an over-refusal on its own error signature), cost `l1`
a fact, and put hallucination back to 0.042 with insufficiency decisions at 3 of 4
(`.eval/llm-runs/ollama-qwen25-3b-gate5`). Net fact coverage did not move: 0.722 before, 0.722 after. A prompt
line that buys no completeness and costs the safety number is not a trade worth making, so the `gate4` wording
ships and the remaining gap is recorded rather than tuned away.

#### 6.2.2 The uncited-hypothesis guard

A live analysis through the api container settled whether the prompt fix holds in production: it does not, on
flash-lite. With a copy brief as the only linked evidence (verified present in `investigation_evidence`, prompt
2 355 chars including the gate), three runs stored `insufficient_evidence: false` with two and three hypotheses
respectively, every one with an empty support set, built from the investigation's own description; the third run
was a 429. So the invariant the prompt asks for is now enforced in code:
`applyEvidenceSupportRule` empties the hypotheses and sets `insufficient_evidence` when no hypothesis cites any
evidence **and** every linked item is `weak` (or nothing is linked). It runs in `analysis.service.ts` after
parsing, and the harness applies the same rule on replay so the change is measurable without a provider call:

| Cache | Before | After the guard |
| --- | --- | --- |
| flash-lite, 20 cases | hallucination 0.050, refusal 0.667, `l8` flagged | **0.000, 1.000, `l8` ok** |
| qwen gate4, 24 cases | 0.000 / facts 0.722 | unchanged |
| qwen pre-gate, 24 cases | 0.083, refusal 0.500, `l8` flagged | unchanged |

The last row is the guard's limit as much as the first is its value: that older `l8` answer cited `E2` — the copy
brief itself — as its support, so a rule about *uncited* claims cannot touch it. Removing claims that rest on
nothing is mechanical; recognising that a claim rests on unrelated evidence is the relevance judgement no parser
has, and it needs a model that follows the gate or a retrieval signal that never offered the item.

`gemini-2.5-flash-lite`'s cached 20 answers were re-scored after the change and are unchanged (`l8` still
flagged), which is what re-scoring a cache must show: the fix changes what the model is asked, so it can only be
proven by asking again — blocked by the 20/day quota.

**Live confirmation, 2026-11-25.** The re-run that was rate-limited above has now been done. On investigation
`da058b95-d709-4867-865f-d852c8cf41ad` (one linked item, the synthetic `website-copy-brief.md`, so every evidence
row is `weak`) the analysis persisted `insufficient_evidence: true` with **zero hypotheses for that analysis**
(`investigation_hypotheses` grouped by `analysis_id`: the seven older rows belong to three pre-guard analyses and
are unchanged). Flash-lite's daily quota was still spent, so the call went through the same
`analyzeInvestigation` path with `ANALYSIS_LLM_MODEL=gemini-3.1-flash-lite`; the row names that model
(`cfd63f52-91a6-40c5-b53b-239ba7b69e35`). This run shows a current model *following* the gate, which is the
better outcome but not the guard firing — the guard itself is proven by the replay numbers above and by the
unit tests, not by this call.

#### Provider constraints measured, not assumed

- **Gemini free tier: 20 requests per model per day.** The API answered
  `429 GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue 20`, `retryDelay 74356s`. Two consequences:
  the 24-case dataset cannot be swept for one model in one day (`--limit` / `--resume` exist for this, and
  `--resume --limit 24` the next day costs only the four missing calls), and a full M3 comparison needs either
  consecutive days or a paid tier.
- `gemini-2.5-flash` answers **404** — "no longer available to new users" — even though `models.list` still
  returns it, and `gemini-3.8-flash` answered **503** ("currently experiencing high demand"). The model ids
  quoted in §7/§12 are therefore stale; the catalogue now runs to `gemini-3.8-flash`, `gemini-3.5-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`. No code change is needed (the provider sends whatever
  `GEMINI_MODEL` names, and a bad name is a readable 502), but the recommendation must not name a retired model.
- Cost estimate from §14 was pessimistic: a 20-case sweep used **~10 K input + 8 K output tokens** against an
  estimated 118 K, so quota — not spend — is the real constraint.

#### 6.2.3 A current Gemini model — measured, and not better than flash-lite on judgement

`gemini-2.5-flash` 404s for new projects and `gemini-3.8-flash` answered 503, so the current-model sweep used
**`gemini-3.5-flash-lite`** (`--limit 20 --delay 15000`, 2026-11-25, `.eval/llm-runs/gemini-35-flash-lite`). It is
the same first-20 slice as the flash-lite cache, so the two columns are comparable:

| Metric | qwen2.5:3b gate4 (24) | gemini-2.5-flash-lite (20) | gemini-3.5-flash-lite (20) |
| --- | --- | --- | --- |
| parsed / schema valid | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| fact coverage | 0.722 | 0.850 | **0.900** |
| citation precision | 1.000 | 1.000 | 1.000 |
| hallucination rate | 0.000 | 0.000 (after the guard) | 0.150 (3 cases) |
| refusal accuracy | 1.000 | 1.000 (after the guard) | 0.600 (3 of 5 decisions) |
| constraint violations | 0 | 0 | 0 |
| dropped citations / invented numbers | 0 / 0 | 0 / 0 | 0 / 0 |
| latency mean / p95 | 7.0 s / 10.4 s | 3.9 s / 22.4 s | 3.3 s / 14.3 s |
| tokens in / out | 11 988 / 5 721 | 10 236 / 8 223 | 12 257 / 5 598 |

Every flag was read against its evidence. Two are real and one is the case's own rule doing its job:

- `l8-refuse-when-evidence-is-unrelated` — the model set `insufficient_evidence: true` and returned an empty
  `hypotheses` list *by itself*, which is exactly what the gate asks for and what flash-lite failed twice before
  it. It is still counted as a hallucination because `next_steps` and `missing_information` name "database
  connection pool metrics" and the case forbids that phrase (L8 asserts zero named services). That is a request
  for evidence rather than a stated cause, but it is a subsystem name the linked item never mentions, so the flag
  stands and is recorded instead of being argued away.
- `l6-follow-up-with-context` and `f2-follow-up-redis` — genuine over-refusals. `l6` claims the material never
  says when the rollback started, although the two timestamps are in the evidence; `f2` refuses to name an
  eviction policy while quoting the one that matters (`volatile-lru`) in the same answer. Refusal accuracy is
  therefore 3 of 5 decisions: `l8`, `l9` and `f3` correct, `l6` and `f2` wrong.

So a newer model buys **completeness** (0.900 facts, the best measured) and pays for it in **judgement**: it is
the first model to over-refuse grounded follow-ups, and the only hallucination flag left on the flash-lite cache
is the same `l8` case, now answered correctly but still naming the forbidden phrase. `gemini-3.5-flash-lite` is a
reasonable analysis default on these numbers; it is not a strict upgrade, and the flash-lite baseline it replaces
was measured on a different prompt.

Still open: the four remaining `gemini-2.5-flash-lite` cases (its daily quota was still spent on 2026-11-25 — the
first uncached call answered 429, so the 24/24 re-record on that model has to wait for a reset), and Groq (needs a
key). Run directories stay in `apps/api/.eval/llm-runs/` on this machine (gitignored, synthetic corpus only).

---

## 7. Free-tier limits and restrictions

| Provider | Free kind | Reset | Real constraint for OpsPilot |
| --- | --- | --- | --- |
| Gemini API | **Permanent free tier** (no expiry, no card) | daily RPD, per-minute RPM/TPM | RPD is the cap; exact numbers per project **(unverified)** — read AI Studio → Rate limits once and record them in the report |
| Groq | **Permanent free plan** | daily TPD + RPD, per-minute | **8 000 TPM is the killer**: a 4 K-token analysis prompt allows ~2 calls/min; 200 K TPD ≈ 40 analyses **or** ~66 RAG answers per day, total |
| Cerebras | **Trial credits, card-gated** | credits expire in 30 days | Not a free tier → excluded by the card-free requirement |
| OpenRouter `:free` | **Permanent but small** | daily | 50 RPD without any purchase — enough for demos, not for a 24-case eval sweep |
| Voyage | **One-time grant**, not monthly | never resets | 200 M tokens ≈ 3 000+ full corpus re-embeds. Excellent for this project, but it is a fixed budget |
| Jina | One-time token grant + rate-limited free tier | rate limits daily-ish | 10 M tokens ≈ 150 corpus re-embeds; dims don't fit 768 |
| Cloudflare Workers AI | **Daily neuron allowance** | daily, 00:00 UTC | 10 000 neurons/day; 1024 d; best privacy terms |
| Cohere | Trial key | monthly call cap | **Non-commercial licence** → excluded |

Not free, for clarity: **Mistral** (API requires billing activation), **Hugging Face Inference Providers**
(free users get no monthly credits; PRO is $2/month). Both were on plausible candidate lists and are false
positives.

---

## 8. Privacy and data-handling considerations

1. **Gemini free tier is an "Unpaid Service".** Google uses inputs *and* outputs to improve its products,
   and human reviewers may read them. This applies to `/ai/ask` questions, investigation descriptions and
   the evidence excerpts sent to the analysis prompt. The paid tier does not do this.
2. **Our prompts contain customer-like operational data.** Even with synthetic demo data, a real user
   typing a real stack trace into a public demo would be sending it to an unpaid service. This must be
   stated in the UI/README, not just the code comments.
3. **Evidence excerpts are capped at 1 200 chars × 12** (`ANALYSIS_LIMITS`) — a natural limit on blast
   radius; keep it.
4. **Never log prompts.** `aiMetrics.util` already logs shaped metadata (counts, lengths, model, timings).
   The new LLM client must keep doing that: log `provider`, `model`, `latencyMs`, `usage`, `errorClass`,
   `httpStatus`, `retryCount` — never `prompt`, never `raw`, never the key.
5. **API keys.** One env var per provider, `.env` only, never in `docker-compose.yml` literals, never in
   the web bundle, never in an eval artifact. `docker-compose*.yml` already pass them through `${VAR:-}`.
6. **Embedding privacy is weaker than it looks.** A cloud embedder sees every chunk of every document.
   Gemini free tier has the same product-improvement terms as generation; Cloudflare `bge-m3` is the only
   candidate with explicit zero data retention. If a user's corpus is sensitive, `fixture` (demo) or a
   self-hosted `openai-compatible` server remains the right answer — which is exactly why the provider
   abstraction must stay.
7. Cohort isolation is unaffected: embeddings are per `organization_id`, and retrieval scoping is in the
   SQL `WHERE`, not post-filtering.

### 8.1 Privacy matrix — the tiers are not equivalent

| Provider / tier | Are prompts and outputs used to improve the product? | Human review possible? | Retention | Card |
| --- | --- | --- | --- | --- |
| **Gemini API — free tier ("Unpaid Service")** | **Yes**, inputs *and* responses, per Google's additional terms | **Yes**, reviewers may read/annotate, disconnected from key/account | per terms | no |
| Gemini API — paid tier | No ("Paid Service") | No | per terms | yes |
| **Groq — free plan** | No training on customer data unless the customer permits it; inputs/outputs not retained by default | No | not retained except for reliability/abuse investigation | no |
| Cerebras — trial | trial terms | — | — | **yes** (disqualified) |
| **OpenRouter `:free`** | model/provider-dependent; routing to a free variant is not a privacy guarantee | provider-dependent | provider-dependent | no |
| **Voyage** | not stated in official docs → treat as **unverified** | unknown | unknown | no |
| Jina | not stated for embeddings → **unverified** | unknown | unknown | no |
| **Cloudflare Workers AI (`bge-m3`)** | No; explicit **zero data retention** for the model | No | none | no |
| Self-hosted `openai-compatible` / Ollama / `fixture` | Nothing leaves the deployment | No | your own | n/a |

The practical consequence for OpsPilot: **the free Gemini tier is the least private option in the list**, and
it is also the one currently wired to `/ai/ask`. Groq is *better* on data terms than Gemini's free tier but
worse on quota and quality evidence. Only `fixture` and a self-hosted endpoint are private.

### 8.2 Evaluation data rule

- Evaluation uses **only** the synthetic corpora already in the repository
  (`retrievalDataset.ts`, `investigationDataset.ts`) plus synthetic prompts written for M2. These contain no
  secrets, no customer data and no production logs.
- No evaluation run points at a real organisation's rows. Any cloud sweep seeds its own ephemeral
  organisation, exactly as `eval:retrieval` does today.
- `fixture` remains the **default for the public demo** until the privacy notice ships: a visitor's upload
  must not be embedded by an unpaid tier by default.
- If a real stack trace is ever used to debug a provider comparison, it is redacted first (hosts, ids,
  tokens) and not committed.
- The README/UI must say, in one sentence, which provider receives data and that the free tier may use it to
  improve the provider's products. That is a product decision this plan cannot make silently.

---

## 9. Recommended LLM and embedding combination

### LLM: keep Gemini, but upgrade the model and add a thin abstraction

- **Primary: `gemini-2.5-flash`** (not `-lite`) for investigation analysis and follow-up answers — these are
  the low-volume, high-value calls where reasoning quality matters, and Flash carries the only RAG-specific
  faithfulness evidence (2.88 % RAGTruth QA). Quota cost is trivial at demo volume.
- **`gemini-2.5-flash-lite` for `/ai/ask`** — high volume, short grounded answers, and the RAG prompt is
  already so constrained that the marginal quality of Flash rarely shows. Configurable per feature.
- **Fallback: `groq/openai/gpt-oss-120b`** — used only when Gemini returns 429/5xx/timeout. It is the only
  other card-free provider with **strict schema-constrained JSON** (`strict: true`), which is exactly what
  an analysis run needs. Its 8 K TPM means it can rescue a handful of requests per minute, not a workload —
  which is the correct role for a fallback.
  **Shipped disabled.** M1 implements the chain but `LLM_FALLBACK_ENABLED` defaults to `false`, so nothing
  reaches Groq until M3 has measured its JSON validity, grounding, refusal behaviour, quota consumption and
  data terms. When enabled, a fallback answer is recorded as the provider/model that produced it and
  `llm.completed` logs `usedFallback: true`; `llm.fallback` logs the reason for the switch.
- **Why not swap primary to Groq?** 8 K TPM caps a 4 K-token analysis to ~2/min, 200 K TPD caps the day at
  ~40 analyses, and the only comparable hallucination measurement is worse than Flash's. It loses on
  capacity and has no quality evidence in its favour for RAG.
- **Why not OpenRouter?** 50 RPD. Fine for a 24-case spot check, unusable as a primary.
- **Why not LiteLLM?** It solves multi-provider routing that we do not need: two endpoints
  (`:generateContent` and `/chat/completions`), ~150 lines of shared code. It would add a Python service
  (or a proxy) into a $0 demo's critical path, plus another network hop and another credential store, to
  replace code we already have half-written. Rejected — with the caveat that if per-provider budgets,
  caching or observability across 5+ providers become real requirements, revisit it.

### Embeddings: **Gemini `gemini-embedding-001`, 768 dims**

Decisive reasons, in order:

1. **Zero schema change.** 768 output fits `VECTOR(768)` and the existing HNSW index
   (`vector_cosine_ops`). No `ALTER COLUMN`, no index type change, no downtime.
2. **Free and card-free**, with a permanent tier rather than a one-time grant.
3. **Retrieval-specific task types** (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`), which nomic lacks — this
   is the single biggest structural upgrade available, independent of raw benchmark scores.
4. It interprets stack traces, log lines and runbooks well enough in the multilingual/technical class of
   models; measured confirmation is the point of §5.2.
5. Same vendor as the LLM → one key, one privacy posture, one quota dashboard. (Note the trade-off: one
   vendor, two failure modes coupled. Mitigated by the `openai-compatible` provider remaining wired.)

**Runner-up: Voyage `voyage-code-3`** if measured retrieval quality on log groups is materially better.
It costs a `VECTOR(1024)` migration plus an index rebuild, and its 200 M-token grant never renews. Take it
only if §5.2 shows a gap large enough to justify a schema migration.

**Baseline to keep working: `nomic-embed-text`.** Not deleted, not defaulted away from in the schema — it
stays as the rollback target and the CI fixture source.

---

## 10. Proposed architecture changes

Smallest maintainable change. No framework, no new dependency.

### 10.1 New: one generation client, two providers

**Implemented in M1** (this is the shipped shape, not a sketch):

```
src/modules/ai/llm/
  provider.ts          # GenerateRequest, LlmResult, LlmProvider -- one generate()
  settings.ts          # LlmProviderSettings, LlmSettings (fallback: ... | null)
  errors.ts            # LlmConfigError, LlmProviderError(status), LlmTimeoutError
  retry.ts             # RetryableFailure, RetryableTimeout, Retry-After, jittered backoff
  gemini.provider.ts   # generateContent + usageMetadata + retries
  openai.provider.ts   # POST {baseUrl}/chat/completions, response_format json_object
  index.ts             # readLlmSettings(), createLlmProvider(), getLlmProvider(), logging
  providers.test.ts    # 17 tests against local stub servers
```

```ts
type GenerateRequest = {
  prompt: string;
  responseFormat?: "text" | "json";   // defaults to "text"
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  jsonSchema?: unknown;               // constrained decoding, where supported
  timeoutMs?: number;
};

type LlmResult = {
  text: string;
  provider: string;      // the backend that actually answered
  model: string;         // the model that actually answered
  generationMs: number;  // includes retry time
  attempts: number;
  usedFallback: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null };
};

interface LlmProvider {
  readonly name: string;                 // "gemini" | "openai-compatible"
  readonly model: string;
  generate(request: GenerateRequest): Promise<LlmResult>;
}
```

One method, two behaviours: a RAG answer passes `responseFormat: "text"` and the provider sends no
`responseMimeType`; an analysis passes `"json"` and it does. There is no `generateJson()` on the prose path.

Configuration (new, additive — existing `GEMINI_*` keep working as aliases):

```
LLM_PROVIDER=gemini                 # gemini | openai-compatible
LLM_MODEL=gemini-2.5-flash
LLM_BASE_URL=                       # for openai-compatible, e.g. https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=2
LLM_FALLBACK_PROVIDER=openai-compatible
LLM_FALLBACK_MODEL=openai/gpt-oss-120b
LLM_FALLBACK_BASE_URL=https://api.groq.com/openai/v1
LLM_FALLBACK_API_KEY=
# per-feature overrides
RAG_LLM_MODEL=gemini-2.5-flash-lite
ANALYSIS_LLM_MODEL=gemini-2.5-flash
```

### 10.2 Two call sites collapse into one — done in M1

- `rag.service.ts:generateAnswer` → `getLlmProvider("rag").generate({ responseFormat: "text", ... })`; the
  duplicated axios call, key handling and Gemini response types are gone. `LlmTimeoutError` →
  `RAGProviderTimeoutError` (504) and `LlmProviderError` → `RAGProviderError` (502), so the endpoint contract
  and the error-middleware mapping are unchanged.
- `analysis.provider.ts:generateJsonResponse` → same client with `responseFormat: "json"`; it now returns
  `{ raw, provider, model, generationMs }`.
- `ANALYSIS_PROVIDER` constant is **deleted**. Attribution rules, implemented:
  1. the analysis row is inserted with `getAnalysisProvider()` / `getAnalysisModel()` (a run that dies still
     names what it attempted);
  2. on success the same row is `UPDATE`d with `result.provider` / `result.model`, so a fallback answer
     overwrites the guess with the truth;
  3. the `analysis_succeeded` activity metadata carries the answering provider/model;
  4. follow-up answers store `generated.provider` / `generated.model` in the activity metadata and return
     them from the API.
  No schema change was needed — the columns already existed, only the values were wrong.

### 10.3 Failure handling contract

- Retry only `408/429/500/502/503/504` and `ECONNABORTED`; never retry `400/401/403` or a validation error.
- Honour `Retry-After`; exponential backoff with jitter, cap 2 retries, cap total wall clock 60 s.
- On primary exhaustion → one fallback attempt → if that fails, the existing typed errors
  (`RAGProviderError` / `RAGProviderTimeoutError`) surface and the existing "failed analysis" row is written.
- **No silent degradation:** if the fallback answered, the stored `model`/`provider` differ from the primary,
  and the metrics log records `fallback: true`.
- Log exactly one line per attempt with `provider, model, attempt, status, latencyMs, promptChars,
  usage` — no prompt text.

### 10.4 Embedding layer: add one provider, change nothing else

`embedding/gemini.provider.ts` implementing the existing `EmbeddingProvider` interface:

- `POST {base}/v1beta/models/gemini-embedding-001:batchEmbedContents` with
  `outputDimensionality: 768`, `taskType: RETRIEVAL_DOCUMENT`, batches of ≤100 (our client batches 16).
- Query path needs `RETRIEVAL_QUERY` — the interface currently has one `embed()` with no task role.
  **Minimal change:** add an optional `role?: "document" | "query"` argument to `embed()`; providers that
  have no task instructions ignore it. This is the only interface change, and it is what makes the upgrade
  worth doing.
- `probe()`: list models (`GET /v1beta/models`) — same quota-free strategy as the OpenAI-compatible
  provider, so `/ai/health` polling costs nothing.
- Normalise 768-d output to unit length before returning (cheap, future-proof for an IP index).
- `EMBEDDING_PROVIDER=gemini`, `EMBEDDING_MODEL=gemini-embedding-001`, `EMBEDDING_DIMENSIONS=768`.
- The `fixture` provider stays; CI keeps working unchanged.

---

## 11. Embedding migration and rollback strategy

**Nothing in this section is executed in this phase.**

### 11.1 Invariants to preserve

1. No query ever compares vectors from two models — already guaranteed by `embedding_model` +
   `embedding_dimensions` in the SQL filter. Do not relax it, do not add an `OR`.
2. `organization_id` scoping is in every statement; the backfill is **per organisation**, never a global
   `UPDATE` without an org predicate.
3. Chunk text, chunk index, `metadata`, `source_created_at`, `tsv` and the ingestion job rows are untouched —
   re-embedding changes **only** `embedding`, `embedding_model`, `embedding_dimensions`.
4. Ingestion state is not reset: no new job rows, no re-parse, no re-chunk.
5. `VECTOR(768)` is unchanged, so the HNSW index stays valid.

### 11.2 Staged migration — production keeps its vectors until the new corpus passes

The first draft of this section re-embedded `source_chunks` in place. That was wrong twice over: it
destroys the old vectors, so reverting the environment restores nothing; and while the backfill runs, every
re-embedded row is invisible to a query embedded with the old model, so retrieval degrades source by source.

Both problems disappear when the new corpus is built where the query path does not read.

```
S0  Freeze ingestion (drain the worker queue); snapshot per-org row counts. Nothing else changes yet.
S1  Snapshot the current vectors -- the rollback source, and it must exist before any write:
      CREATE TABLE source_chunks_embedding_backup AS
        SELECT id, organization_id, embedding, embedding_model, embedding_dimensions,
               now() AS captured_at
        FROM source_chunks;
      ALTER TABLE source_chunks_embedding_backup ADD PRIMARY KEY (id);
    ~3 KB/row: 100 K chunks ~ 300 MB.
S2  Staging table -- the new corpus, read by nothing in production:
      CREATE TABLE source_chunks_embedding_staging (
        chunk_id uuid PRIMARY KEY REFERENCES source_chunks(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL,
        embedding vector(768) NOT NULL,
        embedding_model text NOT NULL,
        embedding_dimensions integer NOT NULL,
        captured_at timestamptz NOT NULL DEFAULT now()
      );
S3  Backfill INTO STAGING ONLY, resumable and rate-limit aware:
      for each org (explicit organization_id predicate, never a global scan):
        for each batch of 16 chunks not yet staged:
          embed(document role) -> assert length 768 -> upsert staging by chunk_id
      checkpoint (org_id, last_chunk_id); a 429 resumes instead of restarting.
      --dry-run reports chunk counts and estimated tokens before spending anything.
S4  Validate the NEW corpus while production still serves the OLD one:
      - retrieval evaluation with the candidate as the query embedder and staging as the corpus
        (new flag --vectors staging);
      - eval:investigations against a scratch organisation seeded with staging vectors;
      - RECALIBRATE (blocking): measure the similarity p50/p90 of relevant vs irrelevant top hits and
        set AI_SEARCH_MIN_SIMILARITY from it; re-check estimateConfidence()'s 0.88/0.78 and 0.80/0.75
        numbers, or the confidence badge becomes fiction.
      Production is untouched throughout: queries still embed with nomic and read nomic rows.
S5  Cutover -- one restart, this order, api and worker stopped:
      1. stop api + worker
      2. UPDATE source_chunks sc
            SET embedding = s.embedding, embedding_model = s.embedding_model,
                embedding_dimensions = s.embedding_dimensions
           FROM source_chunks_embedding_staging s
          WHERE sc.id = s.chunk_id;
         -- verify per-model counts match S0 and zero rows remain on the old model
      3. start api + worker with EMBEDDING_PROVIDER=<new>
      4. unfreeze ingestion
    The only window where rows are new and the process still embeds with the old model is bounded by the
    restart, and no request is served inside it.
S6  Re-record CI fixtures against the new model (npm run embed:fixture -- --record), or the fixture's
    model/dimensions stop representing production and the CI gate loses meaning.
S7  REINDEX INDEX CONCURRENTLY idx_source_chunks_embedding_hnsw_cosine (the existing
    vector-index-rebuild runbook); needed after a bulk update, not for correctness.
S8  Keep the backup for one verified demo cycle, then drop it AND the staging table.
```

### 11.3 Rollback — data, not just configuration

Three separate actions, because they answer different failures.

1. **Configuration rollback (seconds), before S5 only.** Set `EMBEDDING_PROVIDER=ollama`,
   `EMBEDDING_MODEL=nomic-embed-text`, `EMBEDDING_DIMENSIONS=768`, `AI_SEARCH_MIN_SIMILARITY=0.65` and
   restart. This works because production rows are still nomic until S5 -- the exact property the in-place
   plan lacked. After S5 the same action would embed queries with nomic and find no nomic rows: an empty
   result set, not a silent mismatch.
2. **Data rollback (minutes, set-based), after S5.** The complete restore, and the reason S1 exists:

   ```sql
   UPDATE source_chunks sc
      SET embedding = b.embedding,
          embedding_model = b.embedding_model,
          embedding_dimensions = b.embedding_dimensions
     FROM source_chunks_embedding_backup b
    WHERE sc.id = b.id;
   ```

   then restart with the nomic configuration and `REINDEX INDEX CONCURRENTLY`. Row identity, chunk text,
   `metadata`, `source_created_at`, `tsv`, ingestion jobs and `organization_id` are never touched, so no
   source metadata and no ingestion state is lost. Verify
   `SELECT embedding_model, count(*) FROM source_chunks GROUP BY 1` against the S0 snapshot before
   restarting.
3. **Staging discard (seconds).** `TRUNCATE source_chunks_embedding_staging` when the candidate loses at S4.
   Production never changed, so nothing else is required.

**Point of no return:** dropping the backup (S8), after the gates pass and a demo has run end to end.

**The rehearsal is a milestone, not a hope** (M8). Against a scratch database restored from a dump: run
S1 -> S5, then roll back with both (1) and (2); assert the per-model counts and the §5.1 baseline numbers
match exactly; only then repeat on the real database. A rollback nobody has run is not a rollback.

### 11.4 Why a partial migration cannot cause a retrieval gap

The review asked for this specifically, so it is stated as an invariant rather than an intention:

1. **S0–S4 contain no gap at all.** The query path keeps `EMBEDDING_PROVIDER=ollama` and reads rows whose
   `embedding_model` is nomic; staging is a different table that retrieval never names. A half-finished
   backfill is therefore invisible, not harmful.
2. **S5 is the only moment of coexistence**, and it runs with `api` and `worker` stopped: no query and no
   ingestion can observe a mixed table. The `UPDATE … FROM staging` is a single statement, so it either
   applies completely or not at all.
3. **Guard rails that make an accidental gap impossible even if the order is botched:**
   `searchSimilar` filters on `embedding_model` *and* `embedding_dimensions`, so a leftover row is excluded
   rather than compared in the wrong space; S5 step 2 verifies per-model counts before the process starts;
   ingestion is frozen from S0, so nothing writes old-model vectors during the window; and
   `embedding_config_hash` on jobs means a job created during the window is re-run, not reused.
4. **If step 2 half-applies** (process killed), Postgres rolls the statement back; the rehearsal asserts this
   by killing the transaction and re-counting.

### 11.5 What must NOT be done

- No in-place re-embed (it destroys the rollback source and degrades retrieval during the run).
- No mixing of providers within one organisation at query time (the SQL prevents it; do not "fix" a
  temporarily empty result by widening the filter).
- No changing `VECTOR(768)` in this phase — that is a separate, planned migration with its own downtime and
  index rebuild, and it is only needed if a 1024-d runner-up wins.

---

## 12. Estimated free-tier capacity

Assumptions (deliberately conservative, all synthetic): RAG answer ≈ 3 000 in + 400 out tokens;
investigation analysis ≈ 4 500 in + 900 out; follow-up ≈ 4 000 in + 500 out.

| Workload | Volume | Tokens |
| --- | --- | --- |
| Dev/test day | 20 answers, 5 analyses, 10 follow-ups | ≈ 128 K |
| Demo day (5–10 users, one guided session each) | 30 answers, 8 analyses, 15 follow-ups | ≈ 190 K |
| Portfolio month | 200 answers, 40 analyses, 120 follow-ups | ≈ **1.45 M** |
| Embedding, one full corpus re-index | ~210 chunks, 60 K tokens | 60 K |
| Embedding, monthly queries | 400 × 40 tokens | 16 K |

| Provider | Monthly headroom | Verdict |
| --- | --- | --- |
| Gemini generation (free) | RPD-bound, not token-bound **(unverified RPD)** | **Comfortable** for the month above; a 24-case eval sweep costs ~118 K tokens, i.e. a few percent of a day |
| Groq generation (free) | 6 M tokens/month theoretical, but 8 K TPM / 200 K TPD | One demo day ≈ 190 K ≈ the whole daily budget. **Fallback only**; ~40 analyses/day absolute ceiling |
| Gemini embedding (free) | free tier, $0 | Corpus + queries ≪ any plausible per-day cap; the real limit is 2 048 tokens/input, and chunks are ≤400 |
| Voyage embedding | 200 M once | ~3 000 full re-indexes. Not a constraint — the non-renewal is |

**State it plainly:** free tiers support development, evaluation and a small portfolio demo comfortably.
They do **not** support even a modest beta: Groq's 200 K TPD would be exhausted by ~40 investigations, and
Gemini free-tier RPD will throttle a busy day. The honest capacity claim is **"hundreds of AI calls per
month, not thousands"** — which is exactly the stated goal, and no more.

---

## 13. Risks and limitations

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Free-tier quotas are unverifiable from public docs (Gemini removed its static table); numbers may differ per project | High — invalidates capacity maths | Read the AI Studio rate-limit page once at implementation and record actuals in this doc; keep the fallback wired |
| R2 | Free tiers can change or vanish (Cerebras now card-gated; Mistral dropped free API access) | High | Provider config, not code, chooses the backend; no vendor SDK in the app (plain axios) |
| R3 | Recommending a cloud embedder means free-tier **data use for product improvement** on a *public* demo | High | State it in README/UI; keep `fixture` as the demo default for anything user-supplied; never send real secrets/logs |
| R4 | Similarity thresholds (`0.65`, `0.88/0.78`) are nomic-calibrated; a naive model swap silently degrades recall or inflates confidence | High | M3 in §11.2 is blocking; the eval harness prints the similarity distribution |
| R5 | The retrieval harness is at ceiling (R@10 0.99) and cannot rank good models | Medium — could pick the wrong model | Add the hard query set + per-source-type recall (§5.2) before comparing |
| R6 | Gemini free-tier throttling during a live demo | Medium | Fallback provider + pre-demo warm-check via `/ai/health`; cache/limit demo traffic |
| R7 | `gpt-oss-120b`'s higher summarisation-hallucination rate (14.2 % HHEM) could leak in via fallback | Medium | Log `fallback: true`; show the model that answered; do not fall back for the refusal-required case (L8) |
| R8 | Long-context claims are misleading (Flash-Lite: 12 % recall @128K) | Medium | Never grow the prompt: keep 12 evidence × 1 200 chars; do not "use the 1 M window" |
| R9 | Re-embedding a large corpus exceeds a free daily embedding quota mid-run | Medium | Resumable checkpointed backfill, batches of 16, dry-run mode |
| R10 | LLM judge bias if one is added later | Low | Deterministic checks are primary; report judge/human κ and never gate CI on the judge |
| R11 | Backup table increases storage/dump size during migration | Low | Captured in M1; dropped in M7 |
| R12 | No published benchmark exists for multi-source root-cause reasoning | — | Accept; that is why §4 exists. Label any claim about it as measured-locally, not benchmarked |

**Explicitly untested in this phase:** every cloud LLM and embedding candidate against OpsPilot's prompts
(no key, quota gate); Gemini free-tier actual RPM/RPD/TPM; Voyage/Jina data-retention terms (no official
page found); whether Gemini's 768-d truncation preserves nomic-level recall on *our* log-group corpus.

---

## 14. Milestone-based implementation plan

Each milestone is independently testable and independently revertible. **No milestone runs until approved.**

| M | Scope | Deliverable | Verification | Quota cost |
| --- | --- | --- | --- | --- |
| **M0** | ✅ **Done.** Seven review corrections applied (§0.1); `LLM_*` documented in `apps/api/.env.example` with fallback disabled | doc + env comments | reviewed | 0 |
| **M1** | ✅ **Done.** `ai/llm/*`: one `generate()` for text and JSON, Gemini + OpenAI-compatible, retry/back-off/Retry-After, usage capture, opt-in fallback, sanitized logging; `rag.service` + `analysis.provider` wired; provider/model recorded from what answered | 7 source files + 1 test file | `npm run typecheck` clean; `npm test` 251/251; stub-provider end-to-end for `/ai/ask`, analysis and follow-up (§0.3) | **0** (stub) |
| **M2** | ✅ **Done.** LLM eval harness: `src/scripts/evaluateLlm.ts` (`--record` / `--replay` / `--list`, `--case`, `--json`, `--report-only`), 24-case synthetic dataset across 12 scenarios, raw-response cache, deterministic scorers that reuse the production parsers, per-run `review.md` | `eval:llm` script; `.eval/llm-runs/` + `review.md` (gitignored) + `buildEvaluationPrompt()` so the harness sends the production prompt | Replay of hand-written fixtures twice → byte-identical output; invented evidence fails the gate (exit 1); a missing cache file refuses to score (exit 2); `npm test` 276/276 | 0 to build and verify (fixtures); ~118 K tok for the first real `--record` in M3 |
| **M3** | ⏳ **Partial.** Two sweeps recorded: `qwen2.5:3b-instruct` (local Ollama, 24/24) and `gemini-2.5-flash-lite` (free tier, 20/24 — its 20/day quota). Ten flagged responses read and classified; four instrument defects found and fixed; the `l8` unrelated-evidence failure fixed in both prompts (24 local cases: hallucination 0.000, every insufficiency decision correct, fact coverage 0.722 — §6.2.1). A current model is now measured (`gemini-3.5-flash-lite`, 20 cases, §6.2.3) and the live guard check is confirmed (§6.2.2). **Remaining:** the four `gemini-2.5-flash-lite` cases (its quota was still spent on 2026-11-25) and Groq (needs a key) | §6.2 filled in with measured numbers; `review.md` per run | Every remaining flag traced to the model, not the scorer; re-scoring the same cache is byte-identical | 20 Gemini requests (`gemini-3.5-flash-lite`) + 4 local |
| **M4** | ✅ **Done.** Embedding provider `gemini`: `batchEmbedContents`, `outputDimensionality 768`, task roles (document/query), unit-normalise, quota-free `probe()`; `EmbeddingProvider.embed()` took an optional role and the query paths (`retrieval.service`, `/ai/test-search`) now pass `"query"` | `embedding/gemini.provider.ts`; `/ai/health` reports `gemini` | 8 mocked-HTTP unit tests in `providers.test.ts` (no network); `npm run typecheck` clean; `npm test` 291/291; live `probe()` and one 768-d document embedding (norm 1.000) | 2 calls |
| **M5** | ✅ **Done.** Harness upgrade: `--provider/--model` (own ephemeral organization per embedder), `--queries hard` (12 held-out queries), per-source-type recall@10, top-hit similarity p10/p50/p90, `--json <path>` | `eval:retrieval` flags + `hardEvaluationQueries` | Re-run of the 36-query baseline reproduces §5.1 recall/precision/MRR exactly; the one nDCG delta is recorded in §5.2.1 and traced to RRF tie ordering, not to this change | 0 (local) |
| **M6** | Embedding comparison: run M5 for nomic, Gemini, (optionally Voyage) | §5.3 filled in with measured recall/precision/MRR/nDCG/latency/throughput | `eval:investigations` PASS for the candidate | < 300 K tokens |
| **M7** | Decision record: final LLM + embedding choice with numbers; explicit accept/reject for each risk | `docs/phase-5.5-decision.md` | reviewed with you | 0 |
| **M8** | **Only if M7 approves an embedding switch:** backup table, resumable backfill script (`--dry-run`), threshold recalibration, fixture re-record, `REINDEX CONCURRENTLY` | migration scripts + runbook | `eval:investigations` PASS; `eval:retrieval` no regression; rollback rehearsed on a scratch org | corpus tokens |
| **M9** | Deployment wiring: `fixture` stays the public-demo default until M8 verified; document the privacy notice for unpaid tiers | README + `docs/deployment.md` updates | local end-to-end demo | small |

Sequencing rationale: **measure before choosing** (M2/M3 before M7), **client before providers** (M1 so the
comparison runs through production code, not a bespoke script), **embeddings last** because that is the only
change that touches stored data.

---

## Appendix A — reproduce the measured baselines

```bash
# Retrieval: 32 docs (18 distractors), 6 tickets, 6 log events, 36 queries
docker compose exec -T api npx tsx src/scripts/evaluateRetrieval.ts

# Investigation evidence (deterministic, no LLM): 5 cases
docker compose exec -T api npx tsx src/scripts/evaluateInvestigations.ts

# Keep the seeded corpora for inspection
docker compose exec -T api npx tsx src/scripts/evaluateRetrieval.ts --keep
```

Both harnesses create a dedicated ephemeral organisation, label it `… (ephemeral)`, and delete it on exit
unless `--keep` is passed. They never read or write another organisation's rows, and neither touches
existing embeddings. Recorded: 2026-11-24, local Ollama `nomic-embed-text` 768 d, PostgreSQL 16 + pgvector.

## Appendix B — environment variables introduced by the plan

Additive only; no existing variable is renamed or removed.

```
LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL, LLM_API_KEY,
LLM_TIMEOUT_MS, LLM_MAX_RETRIES, LLM_RETRY_BASE_DELAY_MS,
LLM_FALLBACK_PROVIDER, LLM_FALLBACK_MODEL, LLM_FALLBACK_BASE_URL, LLM_FALLBACK_API_KEY,
RAG_LLM_MODEL, ANALYSIS_LLM_MODEL
EMBEDDING_PROVIDER=gemini   # new enum value; ollama | openai-compatible | fixture unchanged
```

## Appendix C — source documents consulted

Google: Gemini API pricing, rate limits, structured output, function calling, embeddings, tokens/billing,
Gemini API additional terms, Flash and Flash-Lite model cards ·
Groq: rate limits, supported models, structured outputs, tool use, your-data, billing FAQ ·
Cerebras: rate limits, models overview, structured outputs, deprecations ·
OpenRouter: API limits, free model variants, free collections ·
Voyage AI: pricing, embeddings, batch inference, rate limits ·
Jina AI: API reference · Cohere: rate limits, embed reference, pricing/FAQ, privacy ·
Cloudflare: Workers AI pricing, bge-m3 model, batch API ·
Hugging Face: Inference Providers pricing · Mistral: usage limits, pricing ·
Vectara: FaithJudge leaderboard, hallucination leaderboard.
