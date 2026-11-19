import React from 'react';
import clsx from 'clsx';

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={index} className="font-semibold text-on-surface">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={index}
          className="rounded border border-line bg-surface-low px-1 py-0.5 font-mono text-[0.92em] text-on-surface"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

/**
 * Lightweight renderer for grounded LLM answers. It preserves paragraphs and
 * bullet structure, and styles bold/inline-code spans without adding a
 * markdown dependency. Unknown markup is rendered as plain text.
 */
export function AiText({ text, className }: { text: string; className?: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div className={clsx('font-body text-body-md leading-relaxed text-on-surface', className)}>
      {lines.map((line, index) => {
        if (!line.trim()) return <div key={index} className="h-1.5" aria-hidden="true" />;

        const bulletMatch = line.match(/^\s*[-*\u2022]\s+(.*)$/);
        const numberedMatch = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        const content = bulletMatch?.[1] ?? numberedMatch?.[2] ?? line;
        const marker = bulletMatch ? '\u2022' : numberedMatch?.[1] ? `${numberedMatch[1]}.` : null;

        return (
          <p key={index} className={clsx('whitespace-pre-wrap', marker ? 'flex gap-2' : 'mt-0.5')}>
            {marker ? (
              <span className="shrink-0 pt-0.5 font-mono text-[11px] text-outline">{marker}</span>
            ) : null}
            <span className="min-w-0">{renderInline(content)}</span>
          </p>
        );
      })}
    </div>
  );
}
