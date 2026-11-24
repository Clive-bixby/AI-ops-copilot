import clsx from 'clsx';
import type { Confidence } from './types';

/**
 * Class tokens and tone helpers for the shared controls.
 *
 * These live beside `components/ui.tsx` rather than inside it because they are
 * not components: a module that exports both cannot be hot-reloaded, so editing
 * `Button` in a dev server reloaded the whole page. The components import from
 * here, and `components/ui.tsx` re-exports the types so existing imports keep
 * working.
 */

export const buttonVariants = {
  primary:
    'bg-primary text-on-primary border border-transparent hover:bg-primary-container active:scale-[0.99]',
  secondary:
    'bg-surface text-on-surface border border-outline-variant hover:bg-surface-low active:scale-[0.99]',
  ghost:
    'bg-transparent text-on-surface-variant border border-transparent hover:bg-surface-low hover:text-on-surface',
  danger:
    'bg-error text-on-error border border-transparent hover:brightness-95 active:scale-[0.99]',
  ai: 'bg-tertiary text-surface-container-lowest border border-transparent hover:bg-tertiary-container active:scale-[0.99]',
  accent:
    'bg-secondary text-on-primary border border-transparent hover:brightness-95 active:scale-[0.99]',
};

export const buttonSizes = {
  sm: 'px-2.5 py-1 text-label-lg gap-1.5',
  md: 'px-3.5 py-2 text-label-lg gap-2',
  lg: 'px-5 py-2.5 text-body-md font-semibold gap-2',
};

export type ButtonVariant = keyof typeof buttonVariants;
export type ButtonSize = keyof typeof buttonSizes;

export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string
) {
  return clsx(
    'inline-flex items-center justify-center rounded font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
    buttonVariants[variant],
    buttonSizes[size],
    className
  );
}

export const badgeTones = {
  neutral: 'bg-surface-low text-on-surface-variant border-outline-variant',
  primary: 'bg-primary-fixed text-primary border-primary/25',
  ok: 'bg-success-surface text-success-ink border-success-line',
  warn: 'bg-warning-surface text-warning-ink border-warning-line',
  critical: 'bg-critical-surface text-critical-ink border-critical-line',
  ai: 'bg-ai-surface text-ai-ink border-ai-border',
  accent: 'bg-secondary/10 text-secondary border-secondary/30',
};

export type BadgeTone = keyof typeof badgeTones;

export function levelTone(level: string | null | undefined): BadgeTone {
  const normalized = (level || '').toLowerCase();
  if (normalized === 'fatal' || normalized === 'error' || normalized === 'crit') return 'critical';
  if (normalized === 'warn' || normalized === 'warning') return 'warn';
  if (normalized === 'debug') return 'neutral';
  if (normalized === 'info') return 'ok';
  return 'neutral';
}

export function priorityTone(priority: string | null | undefined): BadgeTone {
  const normalized = (priority || '').toLowerCase();
  if (normalized === 'urgent' || normalized === 'critical') return 'critical';
  if (normalized === 'high') return 'accent';
  if (normalized === 'medium') return 'warn';
  return 'neutral';
}

export function statusTone(status: string | null | undefined): BadgeTone {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'open') return 'primary';
  if (normalized === 'in_progress' || normalized === 'pending') return 'warn';
  if (normalized === 'resolved') return 'ok';
  if (normalized === 'closed') return 'neutral';
  return 'neutral';
}

export function confidenceTone(confidence: Confidence | null | undefined): BadgeTone {
  if (confidence === 'high') return 'ok';
  if (confidence === 'medium') return 'warn';
  return 'critical';
}
