export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const diff = Date.now() - date.getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let label: string;
  if (abs < 45_000) label = 'just now';
  else if (abs < hour) label = `${Math.round(abs / minute)}m`;
  else if (abs < day) label = `${Math.round(abs / hour)}h`;
  else if (abs < 7 * day) label = `${Math.round(abs / day)}d`;
  else label = date.toLocaleDateString();

  if (label === 'just now') return label;
  return future ? `in ${label}` : `${label} ago`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

export function shortId(value: string | null | undefined, length = 8): string {
  if (!value) return '—';
  return value.slice(0, length).toUpperCase();
}

export function initials(value: string | null | undefined): string {
  if (!value) return 'OP';
  const clean = value.split('@')[0] ?? value;
  const parts = clean.split(/[.\-_\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return '—';
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/[_-]/g, ' ');
}

export function fileType(filename: string): string {
  const extension = filename.split('.').pop();
  return extension ? extension.toUpperCase() : 'FILE';
}

export function fileIcon(filename: string): string {
  const type = fileType(filename);
  if (type === 'PDF') return 'picture_as_pdf';
  if (type === 'CSV') return 'table_chart';
  if (type === 'JSON') return 'data_object';
  if (type === 'YAML' || type === 'YML') return 'code';
  if (type === 'LOG' || type === 'TXT') return 'receipt_long';
  return 'description';
}

export function serializeMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return '—';
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return '—';
  }
}

export function downloadText(filename: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
