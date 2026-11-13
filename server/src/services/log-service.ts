import util from 'node:util';

import { appConfig } from '../config/env.js';

type LogMethod = 'log' | 'error';
type LogTone = 'info' | 'success' | 'warning' | 'error';
type TableRow = [label: string, value: unknown];

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[38;5;81m',
  blue: '\u001b[38;5;117m',
  green: '\u001b[38;5;78m',
  yellow: '\u001b[38;5;221m',
  red: '\u001b[38;5;203m',
  white: '\u001b[38;5;255m',
  gray: '\u001b[38;5;245m'
} as const;

const supportsColor = process.stdout.isTTY && !('NO_COLOR' in process.env) && appConfig.nodeEnv !== 'test';
const TABLE_INDENT = ' '.repeat('[server] '.length);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeString(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function colorize(text: string, ...styles: string[]): string {
  if (!supportsColor || styles.length === 0) {
    return text;
  }

  return `${styles.join('')}${text}${ANSI.reset}`;
}

function toneAccent(tone: LogTone): string {
  if (tone === 'success') {
    return ANSI.green;
  }

  if (tone === 'warning') {
    return ANSI.yellow;
  }

  if (tone === 'error') {
    return ANSI.red;
  }

  return ANSI.blue;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function padRight(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = sanitizeString(value);
    return /[\s=|,[\]{}]/.test(normalized) ? JSON.stringify(normalized) : normalized;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (value instanceof Error) {
    return sanitizeString(value.message);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatScalar(entry)).join(', ')}]`;
  }

  if (isPlainObject(value)) {
    return `{${flattenEntries(value).join(', ')}}`;
  }

  return sanitizeString(util.inspect(value, { depth: 1, breakLength: Infinity, compact: true }));
}

function flattenEntries(value: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];

  for (const [key, nestedValue] of Object.entries(value)) {
    if (nestedValue === undefined) {
      continue;
    }

    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(nestedValue)) {
      parts.push(...flattenEntries(nestedValue, nextKey));
      continue;
    }

    parts.push(`${nextKey}=${formatScalar(nestedValue)}`);
  }

  return parts;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined || meta === null || meta === '') {
    return '';
  }

  if (isPlainObject(meta)) {
    return flattenEntries(meta).join(' | ');
  }

  return formatScalar(meta);
}

function renderPrefix(tone: LogTone): string {
  return colorize('[server]', toneAccent(tone), ANSI.bold);
}

function renderMessage(message: string, tone: LogTone): string {
  const [head, ...rest] = message.split(' | ');
  const styledHead = colorize(head, toneAccent(tone), ANSI.bold);

  if (rest.length === 0) {
    return styledHead;
  }

  const separator = colorize(' | ', ANSI.dim);
  const styledTail = rest.map((part) => colorize(part, ANSI.gray)).join(separator);
  return `${styledHead}${separator}${styledTail}`;
}

function buildTableLines(rows: TableRow[]): string[] {
  const formattedRows = rows.map(([label, value]) => [sanitizeString(label), sanitizeString(formatScalar(value))] as const);
  const labelWidth = Math.max('Metric'.length, ...formattedRows.map(([label]) => label.length));
  const valueWidth = Math.max('Value'.length, ...formattedRows.map(([, value]) => value.length));
  const border = `+${'-'.repeat(labelWidth + 2)}+${'-'.repeat(valueWidth + 2)}+`;
  const header = `| ${padRight('Metric', labelWidth)} | ${padRight('Value', valueWidth)} |`;
  const body = formattedRows.map(([label, value]) => `| ${padRight(label, labelWidth)} | ${padRight(value, valueWidth)} |`);

  return [border, header, border, ...body, border];
}

function renderTableLine(line: string, kind: 'border' | 'header' | 'body', tone: LogTone): string {
  if (kind === 'border') {
    return colorize(line, ANSI.dim);
  }

  if (kind === 'header') {
    return colorize(line, toneAccent(tone), ANSI.bold);
  }

  return colorize(line, ANSI.white);
}

function write(method: LogMethod, message: string, meta?: unknown, tone: LogTone = method === 'error' ? 'error' : 'info'): void {
  const prefix = renderPrefix(tone);

  if (meta === undefined || meta === null || meta === '') {
    const body = supportsColor ? renderMessage(message, tone) : message;
    console[method](`${prefix} ${body}`);
    return;
  }

  if (appConfig.logVerbose) {
    console[method](`${prefix} ${supportsColor ? renderMessage(message, tone) : message}`, meta);
    return;
  }

  const formattedMeta = formatMeta(meta);
  const renderedMessage = supportsColor ? renderMessage(message, tone) : message;
  const renderedMeta = supportsColor ? colorize(formattedMeta, ANSI.gray) : formattedMeta;
  console[method](formattedMeta ? `${prefix} ${renderedMessage}${colorize(' | ', ANSI.dim)}${renderedMeta}` : `${prefix} ${renderedMessage}`);
}

export const log = {
  info(message: string, meta?: unknown): void {
    write('log', message, meta, 'info');
  },
  warn(message: string, meta?: unknown): void {
    write('log', message, meta, 'warning');
  },
  error(message: string, meta?: unknown): void {
    write('error', message, meta, 'error');
  },
  table(title: string, rows: TableRow[], tone: LogTone = 'info'): void {
    write('log', title, undefined, tone);

    const [topBorder, header, divider, ...rest] = buildTableLines(rows);
    const body = rest.slice(0, -1);
    const bottomBorder = rest[rest.length - 1] ?? divider;

    console.log(`${TABLE_INDENT}${renderTableLine(topBorder, 'border', tone)}`);
    console.log(`${TABLE_INDENT}${renderTableLine(header, 'header', tone)}`);
    console.log(`${TABLE_INDENT}${renderTableLine(divider, 'border', tone)}`);

    for (const row of body) {
      console.log(`${TABLE_INDENT}${renderTableLine(row, 'body', tone)}`);
    }

    console.log(`${TABLE_INDENT}${renderTableLine(bottomBorder, 'border', tone)}`);
  }
};
