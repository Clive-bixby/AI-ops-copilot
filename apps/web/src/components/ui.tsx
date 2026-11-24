import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { badgeTones, buttonClass } from '../lib/uiTokens';
import type { BadgeTone, ButtonSize, ButtonVariant } from '../lib/uiTokens';

// Re-exported as types only: a module that also exported values could not be
// hot-reloaded. The helpers themselves live in `lib/uiTokens.ts`.
export type { BadgeTone, ButtonSize, ButtonVariant } from '../lib/uiTokens';

/* ------------------------------------------------------------------ */
/* Icons & classes                                                     */
/* ------------------------------------------------------------------ */

export function Icon({
  name,
  size = 18,
  filled = false,
  className,
}: {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={clsx('material-symbols-outlined shrink-0', className)}
      data-filled={filled ? 'true' : undefined}
      style={{ fontSize: size }}
    >
      {name}
    </span>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
}) {
  return (
    <button className={buttonClass(variant, size, className)} {...props}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export function Badge({
  tone = 'neutral',
  children,
  icon,
  className,
  pulse = false,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  icon?: string;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-label-sm font-semibold uppercase tracking-wider',
        badgeTones[tone],
        className
      )}
    >
      {pulse ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Panels & page chrome                                                */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  icon,
  meta,
  actions,
  children,
  className,
  bodyClassName,
  flush = false,
  as: Tag = 'section',
}: {
  title?: React.ReactNode;
  icon?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  as?: 'section' | 'article' | 'div' | 'aside';
}) {
  return (
    <Tag className={clsx('panel flex flex-col', className)}>
      {title ? (
        <div className="panel-header">
          <div className="flex min-w-0 items-center gap-2">
            {icon ? <Icon name={icon} size={18} className="text-outline" /> : null}
            <h2 className="truncate font-headline-sm text-headline-sm text-on-surface">{title}</h2>
            {meta ? <span className="mono-label hidden text-outline sm:inline">{meta}</span> : null}
          </div>
          {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
        </div>
      ) : null}
      <div className={clsx(flush ? '' : 'p-md', 'flex-1', bodyClassName)}>{children}</div>
    </Tag>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-md border-b border-line pb-md">
      <div className="flex flex-col gap-md lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-1 flex flex-wrap items-center gap-2">{eyebrow}</div> : null}
          <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight sm:text-[32px] sm:leading-[38px]">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-3xl font-body text-body-md text-on-surface-variant">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function Stat({
  label,
  value,
  hint,
  badge,
  icon,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  badge?: React.ReactNode;
  icon?: string;
  tone?: 'default' | 'critical' | 'ai' | 'primary';
}) {
  const toneClass =
    tone === 'critical'
      ? 'text-error'
      : tone === 'ai'
        ? 'text-ai-ink'
        : tone === 'primary'
          ? 'text-primary'
          : 'text-on-surface';

  return (
    <div className="flex flex-col justify-between gap-2 bg-surface p-md">
      <div className="flex items-start justify-between gap-2">
        <span className="mono-label text-outline">{label}</span>
        {icon ? <Icon name={icon} size={16} className="text-outline" /> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={clsx('font-headline-md text-headline-md font-bold tabular', toneClass)}>
          {value}
        </span>
        {badge}
      </div>
      {hint ? <div className="font-body text-body-sm text-on-surface-variant">{hint}</div> : null}
    </div>
  );
}

export function Progress({
  value,
  max = 100,
  tone = 'primary',
  className,
}: {
  value: number;
  max?: number;
  tone?: 'primary' | 'critical' | 'warn' | 'ok' | 'ai';
  className?: string;
}) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const colors = {
    primary: 'bg-primary',
    critical: 'bg-error',
    warn: 'bg-warning',
    ok: 'bg-success',
    ai: 'bg-tertiary',
  };
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-surface-container', className)}>
      <div className={clsx('h-full rounded-full transition-all', colors[tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

export function LoadingState({ label = 'Loading operational data…' }: { label?: string }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 py-10 text-on-surface-variant">
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:300ms]" />
      </div>
      <span className="font-body text-body-sm">{label}</span>
    </div>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
  compact = false,
}: {
  icon?: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-12'
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-outline-variant/70 bg-surface-low text-outline">
        <Icon name={icon} size={22} />
      </div>
      <h3 className="font-headline-sm text-headline-sm text-on-surface">{title}</h3>
      {description ? (
        <p className="max-w-md font-body text-body-sm text-on-surface-variant">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  title = 'Could not load this view',
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-2 rounded border border-critical-line bg-critical-surface/60 text-center',
        compact ? 'px-4 py-6' : 'px-6 py-10'
      )}
    >
      <Icon name="error" size={24} className="text-critical-ink" />
      <h3 className="font-headline-sm text-headline-sm text-critical-ink">{title}</h3>
      <p className="max-w-lg font-body text-body-sm text-critical-ink/90">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry} className="mt-2">
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-critical-line bg-critical-surface px-3 py-2 font-body text-body-sm text-critical-ink">
      <span className="flex items-start gap-2">
        <Icon name="error" size={16} className="mt-0.5" />
        {message}
      </span>
      {onRetry ? (
        <button onClick={onRetry} className="font-semibold underline underline-offset-2">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded bg-surface-container', className)} />;
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('flex flex-col gap-1', className)}>
      <span className="mono-label text-on-surface-variant">{label}</span>
      {children}
      {hint ? <span className="font-body text-body-sm text-outline">{hint}</span> : null}
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { id: T; label: string; count?: number; icon?: string }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-1 border-b border-line', className)} role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={clsx(
              'flex items-center gap-1.5 border-b-2 px-3 py-2 font-label-lg text-label-lg transition-colors',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            )}
          >
            {tab.icon ? <Icon name={tab.icon} size={15} /> : null}
            {tab.label}
            {typeof tab.count === 'number' ? (
              <span
                className={clsx(
                  'rounded px-1 font-mono text-[10px] font-semibold tabular',
                  active ? 'bg-primary-fixed text-primary' : 'bg-surface-container text-on-surface-variant'
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  label = 'records',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  label?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-md py-sm font-body text-body-sm text-on-surface-variant">
      <span className="tabular">
        Showing {start}–{end} of {total} {label}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          icon="chevron_left"
        >
          Prev
        </Button>
        <span className="px-2 font-mono text-label-sm tabular">
          {page} / {pageCount}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
          <Icon name="chevron_right" size={14} />
        </Button>
      </div>
    </div>
  );
}

export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      onClick={copy}
      className={clsx(
        'inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 font-mono text-label-sm text-outline transition-colors hover:border-outline-variant hover:text-on-surface',
        className
      )}
      title={label}
      type="button"
    >
      <Icon name={copied ? 'check' : 'content_copy'} size={13} />
      <span className="hidden sm:inline">{copied ? 'Copied' : label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-2xl',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[rgb(17_24_39/0.45)] p-0 sm:items-center sm:p-6">
      <button
        aria-label="Close dialog"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'animate-enter relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-outline-variant bg-surface shadow-pop sm:rounded-xl',
          width
        )}
      >
        <div className="flex items-start justify-between gap-md border-b border-line px-lg py-md">
          <div>
            <h2 className="font-headline-sm text-headline-sm text-on-surface">{title}</h2>
            {description ? (
              <p className="mt-1 font-body text-body-sm text-on-surface-variant">{description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-outline transition-colors hover:bg-surface-low hover:text-on-surface"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-lg py-md">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-low px-lg py-md">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[65] flex justify-end bg-[rgb(17_24_39/0.4)]">
      <button
        aria-label="Close panel"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
        tabIndex={-1}
      />
      <aside className="animate-enter relative flex h-full w-full max-w-xl flex-col border-l border-outline-variant bg-surface shadow-pop">
        <div className="flex items-start justify-between gap-md border-b border-line px-lg py-md">
          <div className="min-w-0">
            {eyebrow ? <div className="mb-1">{eyebrow}</div> : null}
            <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-outline transition-colors hover:bg-surface-low hover:text-on-surface"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-lg py-md">{children}</div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-low px-lg py-md">
            {actions}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
