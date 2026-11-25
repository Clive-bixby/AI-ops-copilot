# Phase 5.5 — AI provider decision record (M7)

Prepared 2026-11-25. Scope: the LLM and embedding providers OpsPilot ships with, decided from numbers measured on
this machine against synthetic corpora, never from vendor benchmarks. Every figure below is reproducible from the
commands in `docs/phase-5.5-ai-provider-evaluation.md` (cited as §5.3, §6.2, §13). **Status: awaiting your review.**

## 1. Decisions

| # | Decision | Basis |
| --- | --- | --- |
| D1 | **Generation: `gemini-3.5-flash-lite` for `/ai/ask`, investigation analysis and follow-ups** (`LLM_MODEL`, `RAG_LLM_MODEL`, `ANALYSIS_LLM_MODEL`). The deterministic evidence-support guard stays on. | §6.2.3: best measured fact coverage (0.900) and fastest mean latency (3.3 s), schema valid 1.000, citation precision 1.000, 0 invented numbers. Its two defects are recorded, not hidden (§3). |
| D2 | **Fallback stays disabled** (`LLM_FALLBACK_ENABLED=false`) until Groq is measured. | No Groq key; §6.2 measured nothing for it. A fallback with no quality evidence is a second unknown, not a safety net. |
| D3 | **Embeddings: no switch. `nomic-embed-text` (local Ollama) stays the default**; `gemini-embedding-001` remains an implemented, selectable provider but is **not** the default and is **not** approved for the public demo. | §5.3: gemini wins the vector arm (standard 0.880 → 0.954, hard 0.514 → 0.750) **but fails the investigation gate** — precision 0.875 < 0.90, and the two extras score 0.75 / 0.71, exactly what the sources that belong scored, so no threshold separates them. It is also ~4.5× slower per investigation and sends every chunk to an unpaid tier that may train on it. |
| D4 | **M8 (embedding migration) is not approved.** No backup table, no backfill, no re-index, no threshold recalibration. | There is nothing worth migrating *to* yet. D3 is a decision against the switch, not a postponement for scheduling reasons. |
| D5 | **M9 (deployment wiring) proceeds with `fixture` as the public-demo default** and one sentence in the README/UI naming which provider receives data and that the free tier may use it. | §8.1: the free Gemini tier is the least private option in the comparison. |
| D6 | **Thresholds stay as they are**: `AI_SEARCH_MIN_SIMILARITY=0.65`, `EVIDENCE_LIMITS.relatedSimilarity=0.70`. | §5.3: every gemini top hit clears 0.65 (p10 0.6825) and the 0.70 related threshold is not the cause of the gate failure. Tuning a threshold to make a candidate pass would hide the finding. |

## 2. The numbers the decision rests on

**Embeddings** (§5.3, same corpus and labels, one ephemeral organisation per embedder):

| Metric | nomic (default) | gemini-embedding-001 | Verdict |
| --- | --- | --- | --- |
| vector recall@10, standard / hard | 0.8796 / 0.5139 | **0.9537 / 0.7500** | gemini better |
| hybrid recall@10, standard / hard | **0.9907 / 0.9028** | 0.9907 / **0.9306** | tie / gemini better |
| hybrid nDCG@10, standard / hard | **0.9792 / 0.8901** | 0.9721 / **0.9147** | tie / gemini better |
| log-group recall@10 (vector, hard) | 0.0000 | **0.4286** | gemini better |
| vector query latency (standard) | 61 ms avg (local) | 425 ms p50 (network) | nomic better |
| investigation precision | **1.000** (11 selected, 0 extras) | 0.875 (13 selected, 2 extras) | **nomic passes, gemini fails** |
| investigation mean latency | **138 ms** | 589 ms | nomic better |
| data leaving the deployment | none | every chunk | nomic better |

The retrieval-quality argument for gemini is real and large on held-out queries; it is outweighed by an
end-to-end gate it fails and by latency and privacy on the path that actually ships. A better embedder that adds
a `related` document to two of four investigations is a worse product than the one that does not, and the score
table cannot see that — which is why the deterministic gate exists.

**Generation** (§6.2.1–§6.2.3, first 20 cases for the two cloud models, 24 for local qwen):

| Metric | qwen2.5:3b (local, 24) | gemini-2.5-flash-lite (20) | gemini-3.5-flash-lite (20) |
| --- | --- | --- | --- |
| schema valid | 1.000 | 1.000 | 1.000 |
| fact coverage | 0.722 | 0.850 | **0.900** |
| citation precision | 1.000 | 1.000 | 1.000 |
| hallucination rate | 0.000 | 0.000 (after guard) | 0.150 (3 cases) |
| refusal accuracy | 1.000 | 1.000 (after guard) | 0.600 (3 of 5) |
| latency mean / p95 | 7.0 s / 10.4 s | 3.9 s / 22.4 s | **3.3 s / 14.3 s** |
| invented numbers | 0 | 0 | 0 |

`gemini-2.5-flash-lite`'s refusal column is better, but those answers were recorded before the gate wording
shipped and it is the older model id; `gemini-3.5-flash-lite` is the current catalogue entry, is the most complete, and is the only one whose
answers were scored after the guard existed. Choosing the older model for one column would trade a measured
strength for an unmeasured one.

## 3. What we are accepting by choosing `gemini-3.5-flash-lite`

1. **`l8` still names a forbidden service.** It refuses correctly and returns no hypotheses, but `next_steps`
   mentions "database connection pool metrics", which the case forbids. The flag stands; it is a request for
   evidence, not a stated cause, but it is a subsystem the linked item never mentions.
2. **Two grounded follow-ups are over-refused** (`l6`, `f2`): the model says the evidence does not say when the
   rollback started, although both timestamps are present, and refuses to name an eviction policy while quoting
   it. Refusal accuracy is 3 of 5 decisions.
3. **A newer model is not a strict upgrade**, and `gemini-3.5-flash-lite` was measured on 20 of 24 cases (the free
   tier's 20 requests per model per day). The four cases outside that first-20 slice are a gap in the evidence,
   not a known failure.
4. **Privacy**: the free tier may use inputs and outputs to improve Google's products and human reviewers may
   read them. Accepted for synthetic demo data, stated in M9; not accepted for a visitor's own upload, which is
   why `fixture` stays the public default.

## 4. Risk register — accept / reject / close

| # | Risk | Decision | Reason |
| --- | --- | --- | --- |
| R1 | Free-tier quotas unverifiable from public docs | **Accept, with measured actuals** | Generation: 20 requests/model/day (`quotaValue 20`) measured twice. Embeddings: a ~116-request run trips the per-minute cap, measured in §5.3. Recorded here rather than trusted from a table. |
| R2 | Free tiers can change or vanish | **Accept** | Provider selection is configuration; no vendor SDK in the app, plain axios. |
| R3 | Cloud embedder means free-tier data use on a public demo | **Reject the switch** | D3/D5. This alone would not block gemini, but combined with the gate failure it settles it. |
| R4 | Similarity thresholds are nomic-calibrated | **Accept, monitored** | No switch, so no recalibration is due. §5.3 records gemini's distribution anyway (p10 0.6825 / p50 0.7544), so a future switch starts from data, not guesswork. |
| R5 | The retrieval harness is at ceiling and cannot rank models | **Closed** | M5's hard set separates them (vector 0.514 vs 0.750); M6 used it. |
| R6 | Gemini throttling during a live demo | **Accept, mitigated** | 20 requests/model/day plus a 429 retry (10/30/60 s) in the embedding provider; `/ai/health` warm check stays. |
| R7 | A weaker fallback model leaks hallucination | **Accept, gated** | Fallback disabled (D2); attribution logging already records which provider answered. |
| R8 | Long-context claims are misleading | **Accept** | The prompt is unchanged: 12 evidence items × 1 200 chars. Nothing here relies on a large context window. |
| R9 | Re-embedding a corpus exceeds a free daily quota mid-run | **Closed for this phase** | No migration approved (D4). The requirement stands for any future M8. |
| R10 | LLM-judge bias | **Not applicable** | No judge was added; every score is deterministic. |
| R11 | Backup table inflates storage during migration | **Not applicable** | No migration. |
| R12 | No published benchmark for multi-source root-cause reasoning | **Accept** | Any claim in this document is labelled measured-locally. |

## 5. Open items carried forward

- **Groq**: no key, so no sweep; fallback stays disabled and the risk register treats it as unmeasured.
- **Voyage**: not run. Its 200 M-token grant never renews and `voyage-code-3` needs `VECTOR(1024)`; it would be
  judged by the same two gates and is an M8-scale commitment, not a configuration change.
- **`gemini-2.5-flash-lite` 24/24 re-record**: still blocked by its 20/day quota; the four missing cases are the
  difference between a comparable column and a partial one.
- **Embedding calibration** (related threshold 0.70, retrieval floor 0.65): untouched, because the extras are not
  separable from the sources that belong — see §5.3. Revisit only with a different embedder.

## 6. What would reverse D3

A candidate that (a) passes `eval:investigations` unchanged, (b) keeps query latency in the low hundreds of
milliseconds, and (c) whose top-hit similarity distribution still clears the 0.65 floor. `gemini-embedding-001`
meets (c) and fails (a). Any future candidate is judged on all three, in that order, before a migration is
proposed.
