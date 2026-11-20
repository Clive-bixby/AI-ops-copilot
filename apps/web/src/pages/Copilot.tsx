import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { downloadText, shortId } from '../lib/format';
import type { AskResponse } from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  confidenceTone,
} from '../components/ui';
import { AiText } from '../components/AiText';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  response?: AskResponse;
  failed?: boolean;
}

const SUGGESTIONS = [
  'Summarize the most recent error logs and their likely cause.',
  'Which open tickets need immediate triage, and why?',
  'What runbook steps exist for database connection pool exhaustion?',
  'Draft an incident summary grounded in the indexed post-mortems.',
];

export function Copilot() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const deepLinkQuery = searchParams.get('q') ?? '';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoSent = useRef(false);

  const send = async (raw: string) => {
    const question = raw.trim();
    if (!question || loading) return;

    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: question,
    };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setLoading(true);
    setLastQuestion(question);

    try {
      const response = await api.ai.ask(question);
      setMessages((current) => [
        ...current,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: response.answer,
          response,
        },
      ]);
    } catch (caught) {
      setMessages((current) => [
        ...current,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: errorMessage(caught),
          failed: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!deepLinkQuery || autoSent.current) return;
    autoSent.current = true;
    void send(deepLinkQuery);
    // Deep-linked prompt runs once for the URL query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkQuery]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const latestResponse = [...messages]
    .reverse()
    .find((message) => message.response)?.response;

  const exportTranscript = () => {
    const lines = [
      '# OpsPilot investigation transcript',
      '',
      `Exported: ${new Date().toISOString()}`,
      '',
      ...messages.flatMap((message) => {
        if (message.role === 'user') return [`## Operator`, '', message.content, ''];
        const header = [
          '## Copilot',
          '',
          message.response
            ? `Confidence: ${message.response.confidence} · ${message.response.sourceCount} sources · ${Math.round(message.response.metrics.totalMs)}ms`
            : 'Request failed',
          '',
          message.content,
          '',
        ];
        const sources = message.response?.sources.length
          ? [
              '### Sources',
              '',
              ...message.response.sources.map(
                (source) =>
                  `- ${source.sourceType} ${source.sourceId} · ${source.matchType === 'vector' && source.similarity !== null ? `similarity ${source.similarity.toFixed(4)}` : 'keyword match'}`
              ),
              '',
            ]
          : [];
        return [...header, ...sources];
      }),
    ];
    downloadText(`opspilot-transcript-${Date.now()}.md`, lines.join('\n'), 'text/markdown');
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={
          <>
            <span className="eyebrow">AI copilot</span>
            <span className="h-1 w-1 rounded-full bg-outline" />
            <span className="font-mono text-label-sm uppercase tracking-wider text-primary">
              Grounded investigation
            </span>
            {latestResponse ? (
              <Badge tone={confidenceTone(latestResponse.confidence)}>
                {latestResponse.confidence} confidence
              </Badge>
            ) : null}
          </>
        }
        title="Copilot Workspace"
        description="Ask operational questions; answers are retrieved from this organization’s indexed documents, logs and tickets, with citations and confidence scoring."
        actions={
          <>
            <Button
              variant="secondary"
              icon="download"
              onClick={exportTranscript}
              disabled={messages.length === 0}
            >
              Export transcript
            </Button>
            <Button
              variant="secondary"
              icon="add_comment"
              onClick={() => {
                setMessages([]);
                setInput('');
                setLastQuestion(null);
              }}
              disabled={messages.length === 0 && !loading}
            >
              New investigation
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-gutter-desktop xl:grid-cols-12">
        <section className="panel flex h-[calc(100vh-250px)] min-h-[560px] min-w-0 flex-col overflow-hidden xl:col-span-8">
          <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-low px-md py-2">
            <div className="flex items-center gap-2">
              <Icon name="forum" size={17} className="text-outline" />
              <span className="font-headline-sm text-headline-sm text-on-surface">Investigation thread</span>
            </div>
            <span className="font-mono text-label-sm text-outline">
              {messages.filter((message) => message.role === 'user').length} questions
            </span>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-md sm:p-lg">
            {messages.length === 0 ? (
              <div className="mx-auto flex max-w-xl flex-col items-center py-6 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg border border-ai-border bg-ai-surface text-ai-ink">
                  <Icon name="neurology" size={26} filled />
                </div>
                <h2 className="font-headline-md text-headline-md text-on-surface">Ask the operations copilot</h2>
                <p className="mt-1 font-body text-body-md text-on-surface-variant">
                  Every answer is generated from retrieved context in this workspace. If the corpus
                  doesn’t contain an answer, the copilot says so instead of inventing one.
                </p>
                <div className="mt-5 grid w-full gap-1.5 text-left sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => void send(suggestion)}
                      className="rounded border border-outline-variant bg-surface-low p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-surface"
                    >
                      <Icon name="north_east" size={14} className="mb-1 text-primary" />
                      <span className="font-body text-body-sm text-on-surface">{suggestion}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) =>
                message.role === 'user' ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%]">
                      <div className="mb-1 text-right font-mono text-[10px] uppercase tracking-wider text-outline">
                        Operator
                      </div>
                      <div className="rounded border border-outline-variant bg-surface-container px-3.5 py-2.5 font-body text-body-md text-on-surface">
                        {message.content}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={message.id} className="max-w-full">
                    <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ai-ink">
                      <Icon name="neurology" size={13} filled />
                      Copilot synthesis
                      {message.response ? (
                        <Badge tone={confidenceTone(message.response.confidence)} className="ml-1">
                          {message.response.confidence}
                        </Badge>
                      ) : null}
                    </div>
                    {message.failed ? (
                      <div className="rounded border border-critical-line bg-critical-surface p-3">
                        <div className="mb-2 flex items-start gap-2 font-body text-body-sm text-critical-ink">
                          <Icon name="error" size={16} className="mt-0.5" />
                          {message.content}
                        </div>
                        {lastQuestion ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="refresh"
                            onClick={() => void send(lastQuestion)}
                            disabled={loading}
                          >
                            Retry question
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <div className="ai-panel p-md">
                        <AiText text={message.content} />

                        {message.response ? (
                          <>
                            <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-ai-border pt-2 font-mono text-label-sm text-ai-ink">
                              <span>{message.response.sourceCount} cited chunks</span>
                              <span className="text-ai-ink/50">|</span>
                              <span>{Math.round(message.response.metrics.totalMs)}ms total</span>
                              <span className="text-ai-ink/50">|</span>
                              <span>
                                retrieval {Math.round(message.response.metrics.retrievalMs)}ms · generation{' '}
                                {Math.round(message.response.metrics.generationMs)}ms
                              </span>
                            </div>

                            {message.response.sources.length > 0 ? (
                              <div className="mt-2 space-y-1.5">
                                {message.response.sources.map((source) => (
                                  <button
                                    key={`${message.id}-${source.sourceType}-${source.sourceId}-${source.chunkIndex}`}
                                    onClick={() => {
                                      if (source.documentId) {
                                        navigate(`/documents?doc=${source.documentId}`);
                                      }
                                    }}
                                    className="flex w-full items-start gap-2 rounded border border-ai-border bg-surface p-2 text-left transition-colors hover:border-ai-ink"
                                  >
                                    <Icon name="description" size={15} className="mt-0.5 text-ai-ink" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-outline">
                                        <span>{shortId(source.sourceId, 10)}</span>
                                        <span>·</span>
                                        <span>chunk {source.chunkIndex}</span>
                                        <span>·</span>
                                        <span className="text-on-surface-variant">
                                          {source.matchType === 'vector' &&
                                          source.similarity !== null
                                            ? `${source.similarity.toFixed(4)} cosine`
                                            : 'keyword match'}
                                        </span>
                                      </div>
                                      <p className="mt-0.5 line-clamp-2 font-body text-body-sm text-on-surface-variant">
                                        {source.preview}
                                      </p>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              )
            )}

            {loading ? (
              <div className="flex items-start gap-2">
                <div className="flex items-center gap-1.5 rounded border border-ai-border bg-ai-surface px-3 py-2 font-mono text-label-sm text-ai-ink">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai-ink" />
                  Retrieving chunks and synthesizing an answer…
                </div>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div className="border-t border-line bg-surface-low p-md">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
              className="relative"
            >
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                placeholder="Ask about logs, incidents, runbooks or the current state of the workspace…"
                aria-label="Ask the copilot"
                className="input min-h-[76px] resize-none pb-9 font-body text-body-md"
              />
              <div className="absolute inset-x-2.5 bottom-2 flex items-center justify-between">
                <span className="font-mono text-[10px] text-outline">
                  Enter to send · Shift+Enter for newline
                </span>
                <Button
                  type="submit"
                  size="sm"
                  variant="ai"
                  icon={loading ? 'sync' : 'auto_awesome'}
                  disabled={loading || !input.trim()}
                >
                  {loading ? 'Working…' : 'Send'}
                </Button>
              </div>
            </form>
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-gutter xl:col-span-4">
          <Panel
            title="Retrieved evidence"
            icon="format_quote"
            meta={latestResponse ? `${latestResponse.sourceCount} sources` : 'RAG grounded'}
            flush
          >
            {latestResponse && latestResponse.sources.length > 0 ? (
              <div className="divide-y divide-line">
                {latestResponse.sources.map((source, index) => (
                  <div
                    key={`${source.sourceType}-${source.sourceId}-${index}`}
                    className="p-md"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-label-sm text-outline">
                        SOURCE {index + 1} · chunk {source.chunkIndex}
                      </span>
                      <Badge
                        tone={
                          source.similarity !== null && source.similarity >= 0.8
                            ? 'ok'
                            : 'neutral'
                        }
                      >
                        {source.similarity !== null
                          ? source.similarity.toFixed(3)
                          : 'keyword'}
                      </Badge>
                    </div>
                    <p className="line-clamp-4 font-body text-body-sm text-on-surface-variant">
                      {source.preview}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="font-mono text-[10px] text-outline">
                        {shortId(source.sourceId, 10)}
                      </span>
                      {source.documentId ? (
                        <button
                          onClick={() =>
                            navigate(`/documents?doc=${source.documentId}`)
                          }
                          className="font-label-lg text-label-lg font-semibold text-primary hover:underline"
                        >
                          Open source
                        </button>
                      ) : (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-outline">
                          keyword match
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon="format_quote"
                title="Evidence will appear here"
                description="Send a question and the retrieved chunks, similarity scores and timing metrics for the latest answer are listed here."
              />
            )}
          </Panel>

          <Panel title="Grounding scope" icon="policy">
            <ul className="space-y-2 font-body text-body-sm text-on-surface-variant">
              {[
                'Retrieves embedded document chunks from pgvector, scoped to your organization.',
                'Falls back to recent logs and tickets when no chunk clears the similarity threshold.',
                'Returns the exact sources used, their similarity and the grounding confidence.',
                'Answers with “No reliable operational context found.” rather than inventing incidents.',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Icon name="check_small" size={15} className="mt-0.5 text-success" />
                  {line}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-start gap-2 border-t border-line pt-2 font-body text-[11px] leading-relaxed text-outline">
              <Icon name="info" size={14} className="mt-0.5 shrink-0" />
              This thread lives in the browser for the current session. Conversation history and
              streaming responses are not persisted by the API.
            </div>
            {latestResponse ? (
              <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-outline">Answer latency</span>
                <span className="font-mono text-code-sm text-on-surface">
                  {Math.round(latestResponse.metrics.totalMs)}ms
                </span>
              </div>
            ) : null}
          </Panel>

          <div className="panel p-md">
            <div className="mb-2 flex items-center justify-between">
              <span className="mono-label text-outline">Latest answer metadata</span>
              {latestResponse ? (
                <CopyButton
                  value={JSON.stringify(latestResponse, null, 2)}
                  label="JSON"
                />
              ) : null}
            </div>
            {latestResponse ? (
              <dl className="space-y-1 font-mono text-[11px]">
                {[
                  ['Confidence', latestResponse.confidence],
                  ['Cited sources', String(latestResponse.sourceCount)],
                  ['Embedding', `${Math.round(latestResponse.metrics.embeddingMs)}ms`],
                  ['Retrieval', `${Math.round(latestResponse.metrics.retrievalMs)}ms`],
                  ['Generation', `${Math.round(latestResponse.metrics.generationMs)}ms`],
                  ['Total', `${Math.round(latestResponse.metrics.totalMs)}ms`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <dt className="text-outline">{label}</dt>
                    <dd className={clsx('text-on-surface', label === 'Confidence' && 'uppercase tracking-wider')}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="font-body text-body-sm text-outline">No answer generated yet.</p>
            )}
          </div>
        </aside>
      </div>

    </div>
  );
}
