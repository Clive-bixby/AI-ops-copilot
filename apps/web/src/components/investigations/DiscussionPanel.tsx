import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, relativeTime } from '../../lib/format';
import { relevanceTone, sourceLabel } from '../../lib/investigation';
import type { FollowUpAnswer, InvestigationDetail } from '../../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  InlineError,
  LoadingState,
} from '../ui';

type ActivityEntry = InvestigationDetail['activity'][number];

function isDiscussionEntry(entry: ActivityEntry): boolean {
  return entry.type === 'note' || entry.type === 'comment';
}

function DiscussionEntry({ entry }: { entry: ActivityEntry }) {
  return (
    <li className="px-md py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={entry.type === 'comment' ? 'primary' : 'neutral'}>
          {entry.type === 'comment' ? 'Comment' : 'Note'}
        </Badge>
        <span className="font-label-lg text-label-lg text-on-surface">
          {entry.actorEmail ?? 'Unknown author'}
        </span>
        <span
          className="ml-auto font-mono text-label-sm text-outline"
          title={formatDateTime(entry.createdAt)}
        >
          {relativeTime(entry.createdAt)}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap font-body text-body-md text-on-surface">
        {entry.body}
      </p>
    </li>
  );
}

function QuestionEntry({ answer }: { answer: FollowUpAnswer }) {
  return (
    <li className="border-b border-line px-md py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="ai" icon="auto_awesome">
          AI answer
        </Badge>
        <Badge tone={answer.confidence === 'high' ? 'ok' : answer.confidence === 'medium' ? 'warn' : 'critical'}>
          {answer.confidence} confidence
        </Badge>
        <span className="ml-auto font-mono text-label-sm text-outline">
          {relativeTime(answer.createdAt)}
        </span>
      </div>

      <p className="mt-1.5 font-label-lg text-label-lg font-semibold text-on-surface">
        {answer.question}
      </p>
      <p className="mt-1 whitespace-pre-wrap font-body text-body-md text-on-surface-variant">
        {answer.answer}
      </p>

      {answer.insufficientContext ? (
        <p className="mt-1.5 rounded border border-warning-line bg-warning-surface px-2.5 py-1.5 font-body text-body-sm text-warning-ink">
          The model judged the stored evidence insufficient to answer this. Nothing was
          invented to fill the gap.
        </p>
      ) : null}

      {answer.citations.length > 0 ? (
        <div className="mt-2">
          <div className="mono-label text-outline">Cited evidence</div>
          <ul className="mt-1 space-y-1">
            {answer.citations.map((citation) => (
              <li
                key={`${answer.activityId}-${citation.evidenceId}`}
                className="flex flex-wrap items-center gap-1.5 rounded border border-line bg-surface-low px-2 py-1"
              >
                <Badge tone="neutral">{sourceLabel(citation.sourceType)}</Badge>
                <Badge tone={relevanceTone(citation.relevance)}>{citation.relevance}</Badge>
                <span className="min-w-0 flex-1 truncate font-body text-body-sm text-on-surface">
                  {citation.sourceTitle}
                </span>
                <span className="font-mono text-label-sm text-outline">
                  {citation.sourceCreatedAt
                    ? formatDateTime(citation.sourceCreatedAt)
                    : 'no source time'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 font-mono text-label-sm text-outline">
          No citations were returned.
        </p>
      )}
    </li>
  );
}

export function DiscussionPanel({
  investigationId,
  activity,
  onChanged,
}: {
  investigationId: string;
  activity: ActivityEntry[];
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [posting, setPosting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const [questions, setQuestions] = useState<FollowUpAnswer[] | null>(null);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  const discussion = activity
    .filter(isDiscussionEntry)
    // The API returns newest first; a conversation reads oldest first.
    .slice()
    .reverse();

  const loadQuestions = async () => {
    setQuestionsLoading(true);
    setQuestionsError(null);

    try {
      const result = await api.investigations.listQuestions(investigationId);
      setQuestions(result.questions);
    } catch (caught) {
      setQuestionsError(errorMessage(caught));
    } finally {
      setQuestionsLoading(false);
    }
  };

  const postNote = async () => {
    const body = note.trim();

    if (body.length === 0) {
      setNoteError('Write something before posting.');
      return;
    }

    setPosting(true);
    setNoteError(null);

    try {
      await api.investigations.createNote(investigationId, body);
      setNote('');
      await onChanged();
    } catch (caught) {
      setNoteError(errorMessage(caught));
    } finally {
      setPosting(false);
    }
  };

  const ask = async () => {
    const text = question.trim();

    if (text.length === 0) {
      setQuestionsError('Enter a question first.');
      return;
    }

    setAsking(true);
    setQuestionsError(null);

    try {
      await api.investigations.askQuestion(investigationId, text);
      setQuestion('');
      await loadQuestions();
    } catch (caught) {
      setQuestionsError(errorMessage(caught));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="panel flex flex-col">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Icon name="forum" size={18} className="text-outline" />
            <h2 className="font-headline-sm text-headline-sm text-on-surface">
              Discussion
            </h2>
            <span className="mono-label hidden text-outline sm:inline">
              {discussion.length} {discussion.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>
        </div>

        {discussion.length === 0 ? (
          <EmptyState
            compact
            icon="sticky_note_2"
            title="No notes yet"
            description="Notes are durable, attributed and never edited. They stay available after the investigation is closed."
          />
        ) : (
          <ol className="max-h-[420px] divide-y divide-line overflow-y-auto">
            {discussion.map((entry) => (
              <DiscussionEntry key={entry.id} entry={entry} />
            ))}
          </ol>
        )}

        <div className="mt-auto space-y-2 border-t border-line p-md">
          {noteError ? <InlineError message={noteError} /> : null}
          <label className="flex flex-col gap-1">
            <span className="mono-label text-on-surface-variant">Add a note</span>
            <textarea
              className="textarea min-h-[80px]"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={4000}
              placeholder="What did you check, and what did you learn?"
            />
          </label>
          <div className="flex justify-end">
            <Button
              size="sm"
              icon="send"
              onClick={() => void postNote()}
              disabled={posting}
            >
              {posting ? 'Posting…' : 'Post note'}
            </Button>
          </div>
        </div>
      </section>

      <section className="panel flex flex-col">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Icon name="help" size={18} className="text-outline" />
            <h2 className="font-headline-sm text-headline-sm text-on-surface">
              Questions
            </h2>
            <span className="mono-label hidden text-outline sm:inline">
              answers use stored evidence only
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            onClick={() => void loadQuestions()}
            disabled={questionsLoading}
          >
            Load
          </Button>
        </div>

        <div className="border-b border-line bg-surface-low px-md py-2">
          <p className="font-body text-body-sm text-outline">
            Follow-up answers are AI suggestions grounded in this investigation&apos;s
            evidence and analysis. They are not findings, and citations are required to
            make a claim.
          </p>
        </div>

        {questionsError ? (
          <div className="p-md">
            <InlineError message={questionsError} />
          </div>
        ) : null}

        {questions === null ? (
          questionsLoading ? (
            <LoadingState label="Loading questions…" />
          ) : (
            <EmptyState
              compact
              icon="quiz"
              title="Questions not loaded"
              description="Load the recorded exchanges, or ask the first question below."
            />
          )
        ) : questions.length === 0 ? (
          <EmptyState
            compact
            icon="quiz"
            title="No questions asked yet"
            description="Answers are stored as activity so the exchange is part of the record."
          />
        ) : (
          <ol className="max-h-[360px] divide-y divide-line overflow-y-auto">
            {questions.map((answer) => (
              <QuestionEntry key={answer.activityId} answer={answer} />
            ))}
          </ol>
        )}

        <div className="mt-auto space-y-2 border-t border-line p-md">
          <label className="flex flex-col gap-1">
            <span className="mono-label text-on-surface-variant">Ask a question</span>
            <textarea
              className="textarea min-h-[70px]"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={500}
              placeholder="What evidence points at the connection pool?"
            />
          </label>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ai"
              icon="auto_awesome"
              onClick={() => void ask()}
              disabled={asking}
            >
              {asking ? 'Answering…' : 'Ask'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
