import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { shortId } from '../lib/format';
import type { AskResponse, SearchResponse } from '../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  InlineError,
  PageHeader,
  Panel,
  Progress,
} from '../components/ui';
import { confidenceTone } from '../lib/uiTokens';
import { AiText } from '../components/AiText';

type AnswerState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; response: AskResponse }
  | { phase: 'error'; message: string };

export function Search() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';

  const [query, setQuery] = useState(initialQuery);
  const [limit, setLimit] = useState(5);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerState>({ phase: 'idle' });
  const autoRan = useRef(false);

  const runSearch = async (value?: string) => {
    const trimmed = (value ?? query).trim();
    if (trimmed.length < 3) {
      setError('Enter at least 3 characters — the retrieval endpoint enforces a minimum query length.');
      return;
    }

    setQuery(trimmed);
    setLoading(true);
    setError(null);
    setAnswer({ phase: 'idle' });

    try {
      const response = await api.ai.search(trimmed, limit);
      setResult(response);
    } catch (caught) {
      setError(errorMessage(caught));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initialQuery || autoRan.current) return;
    autoRan.current = true;
    void runSearch(initialQuery);
    // Run once for the deep-linked query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const generateAnswer = async () => {
    if (!result?.query) return;
    setAnswer({ phase: 'loading' });
    try {
      const response = await api.ai.ask(result.query);
      setAnswer({ phase: 'done', response });
    } catch (caught) {
      setAnswer({ phase: 'error', message: errorMessage(caught) });
    }
  };

  const examples = [
    'How should we recover from PostgreSQL connection pool exhaustion?',
    'What is the rollback procedure for a failed deployment?',
    'Which runbook covers vector index rebuilds?',
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">Retrieval engine</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              pgvector · cosine similarity
            </span>
            <span className="hidden h-1 w-1 rounded-full bg-outline sm:inline" />
            <span className="hidden font-mono text-label-sm uppercase tracking-wider text-outline sm:inline">
              Organization scoped
            </span>
          </>
        }
        title="Semantic Knowledge Search"
        description="Query the indexed document chunks directly, inspect similarity scores, then generate a grounded answer with citations from the same retrieval pipeline the copilot uses."
      />

      <section className="panel p-md sm:p-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
          className="flex flex-col gap-2 md:flex-row md:items-center"
        >
          <div className="relative flex-1">
            <Icon name="travel_explore" size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-primary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Describe the operational question or failure mode…"
              aria-label="Semantic search query"
              className="input h-11 pl-10 pr-10 font-body text-body-md"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setResult(null);
                  setError(null);
                  setAnswer({ phase: 'idle' });
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-outline hover:bg-surface-container hover:text-on-surface"
                aria-label="Clear query"
              >
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </div>
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="select h-11 w-[150px]"
            aria-label="Number of results"
          >
            {[3, 5, 10].map((value) => (
              <option key={value} value={value}>
                Top {value} chunks
              </option>
            ))}
          </select>
          <Button type="submit" size="lg" icon={loading ? 'sync' : 'search'} disabled={loading} className="h-11">
            {loading ? 'Searching…' : 'Search vectors'}
          </Button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-label-sm text-outline">
                      <Badge tone="neutral">documents · log groups · tickets</Badge>
          <Badge tone="primary">pgvector + full-text</Badge>
          <span className="tabular">Min query 3 chars · max 500 · limit 1–10</span>
          <span className="ml-auto hidden items-center gap-1 sm:flex">
            <Icon name="lock" size={12} /> tenant-filtered
          </span>
        </div>
      </section>

      {error ? <InlineError message={error} onRetry={() => void runSearch()} /> : null}

      {!result && !loading && !error ? (
        <Panel title="Start a retrieval" icon="manage_search">
          <div className="grid gap-3 md:grid-cols-3">
            {examples.map((example) => (
              <button
                key={example}
                onClick={() => void runSearch(example)}
                className="rounded border border-outline-variant bg-surface-low p-3 text-left transition-colors hover:border-primary/40 hover:bg-surface"
              >
                <Icon name="north_east" size={15} className="mb-1 text-primary" />
                <div className="font-body text-body-sm text-on-surface">{example}</div>
              </button>
            ))}
          </div>
          <p className="mt-3 border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
            The backend searches embedded documents, grouped log templates and tickets with cosine
            similarity. Keyword/hybrid search, source-type filters and result pagination are not
            exposed by the current API.
          </p>
        </Panel>
      ) : null}

      {result ? (
        <>
          <div className="panel flex flex-wrap items-center justify-between gap-2 px-md py-2.5">
            <div className="flex flex-wrap items-center gap-2 font-mono text-label-sm">
              <Badge tone="primary">{result.totalResults} chunks</Badge>
              <span className="text-outline">
                Retrieved in <strong className="text-on-surface tabular">{result.executionTimeMs}ms</strong>
              </span>
              <span className="hidden text-outline sm:inline">·</span>
              <span className="hidden truncate text-on-surface-variant sm:inline">“{result.query}”</span>
            </div>
            <div className="flex items-center gap-2">
              {answer.phase === 'idle' || answer.phase === 'error' ? (
                <Button variant="ai" size="sm" icon="auto_awesome" onClick={() => void generateAnswer()}>
                  Generate grounded answer
                </Button>
              ) : answer.phase === 'loading' ? (
                <span className="flex items-center gap-1.5 font-mono text-label-sm text-ai-ink">
                  <Icon name="sync" size={14} className="animate-spin" /> Synthesizing…
                </span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="neurology"
                  onClick={() => navigate(`/copilot?q=${encodeURIComponent(result.query)}`)}
                >
                  Open in Copilot
                </Button>
              )}
            </div>
          </div>

          {answer.phase === 'error' ? (
            <InlineError message={answer.message} onRetry={() => void generateAnswer()} />
          ) : null}

          {answer.phase === 'done' ? (
            <div className="ai-panel p-md">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ai-border pb-2">
                <div className="flex items-center gap-1.5">
                  <Icon name="neurology" size={16} className="text-ai-ink" filled />
                  <span className="font-mono text-label-sm font-bold uppercase tracking-wider text-ai-ink">
                    AI synthesis // grounded answer
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={confidenceTone(answer.response.confidence)}>
                    {answer.response.confidence} confidence
                  </Badge>
                  <span className="font-mono text-label-sm text-ai-ink">
                    {answer.response.sourceCount} sources
                  </span>
                </div>
              </div>
              <AiText text={answer.response.answer} className="mt-2" />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {answer.response.sources.map((source) => (
                  <button
                    key={`${source.sourceType}-${source.sourceId}-${source.chunkIndex}`}
                    onClick={() => {
                      if (source.documentId) {
                        navigate(`/documents?doc=${source.documentId}`);
                      }
                    }}
                    className="flex items-center gap-1 rounded border border-ai-border bg-surface px-1.5 py-1 font-mono text-[10px] text-on-surface-variant transition-colors hover:border-ai-ink"
                  >
                    <Icon name="description" size={12} className="text-ai-ink" />
                    {shortId(source.sourceId, 6)} · {source.sourceType}
                    {source.sourceType === 'document'
                      ? ` · chunk ${source.chunkIndex}`
                      : ''}{' '}
                    ·{' '}
                    {source.similarity !== null
                      ? source.similarity.toFixed(3)
                      : 'keyword'}
                  </button>
                ))}
              </div>
              <div className="mt-2 border-t border-ai-border pt-1.5 font-mono text-[10px] text-ai-ink/80">
                embedding {Math.round(answer.response.metrics.embeddingMs)}ms · retrieval{' '}
                {Math.round(answer.response.metrics.retrievalMs)}ms · generation{' '}
                {Math.round(answer.response.metrics.generationMs)}ms
              </div>
            </div>
          ) : null}

          <div className="space-y-2.5">
            <div className="flex items-center justify-between px-0.5">
              <h2 className="font-headline-sm text-headline-sm text-on-surface">Retrieved operational evidence</h2>
              <span className="font-mono text-label-sm text-outline">fused by reciprocal rank (RRF)</span>
            </div>

            {result.results.length === 0 ? (
              <Panel>
                <EmptyState
                  icon="search_off"
                  title="No chunks cleared the similarity threshold"
                  description="Try different wording, or add the relevant runbook to the knowledge base so it can be embedded."
                  action={
                    <Button size="sm" variant="secondary" icon="upload_file" onClick={() => navigate('/documents')}>
                      Open knowledge base
                    </Button>
                  }
                />
              </Panel>
            ) : (
              result.results.map((item, index) => (
                <article key={`${item.sourceType}-${item.sourceId}-${item.chunkIndex}-${index}`} className="panel overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-low px-md py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="primary">
                        {item.sourceType} // {item.matchType}
                      </Badge>
                      <span className="font-mono text-label-sm text-outline">
                        {shortId(item.sourceId, 10)} · chunk {item.chunkIndex}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-label-sm text-on-surface-variant">
                        {item.similarity !== null
                          ? `cosine ${item.similarity.toFixed(4)}`
                          : 'keyword match'}
                      </span>
                      {item.similarity !== null ? (
                        <div className="w-20">
                          <Progress
                            value={item.similarity * 100}
                            tone={item.similarity >= 0.8 ? 'ok' : 'primary'}
                          />
                        </div>
                      ) : null}
                      <span className="font-mono text-[10px] text-outline">
                        score {item.score.toFixed(4)}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2 p-md">
                    <p className="font-body text-body-md leading-relaxed text-on-surface">
                      {item.preview || item.content}
                    </p>
                    <details className="rounded border border-outline-variant bg-surface-low">
                      <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-label-sm uppercase tracking-wider text-on-surface-variant">
                        Full retrieved chunk
                      </summary>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line p-2.5 font-mono text-[11px] leading-relaxed text-on-surface-variant">
                        {item.content}
                      </pre>
                    </details>
                    <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
                      {item.documentId ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="open_in_new"
                          onClick={() => navigate(`/documents?doc=${item.documentId}`)}
                        >
                          Open document
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="neurology"
                        onClick={() =>
                          navigate(
                            `/copilot?q=${encodeURIComponent(
                              `Explain this retrieved chunk in operational context: ${item.preview || item.content.slice(0, 300)}`
                            )}`
                          )
                        }
                      >
                        Ask about chunk
                      </Button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        </>
      ) : loading ? (
        <Panel>
          <div className="flex flex-col items-center gap-2 py-10 text-on-surface-variant">
            <Icon name="travel_explore" size={24} className="animate-pulse text-primary" />
            <span className="font-body text-body-sm">Embedding query and scanning the vector index…</span>
            <span className="font-mono text-[10px] text-outline">Postgres · pgvector cosine distance</span>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
