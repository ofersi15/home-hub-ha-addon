/**
 * Structured JSON-line logger. Never logs secrets:
 *  - keys that look secret (key, token, signature, code, password, secret, authorization) are masked;
 *  - every value registered with `registerSecret()` (device key, Supervisor token, custom token) is
 *    scrubbed from all strings, wherever it appears.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEY = /(key|token|signature|secret|password|authorization|pairing_?code|^code$)/i;
const secrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

/** Test helper. */
export function clearSecrets(): void {
  secrets.clear();
}

function scrubString(s: string): string {
  let out = s;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v != null && v !== '' && typeof v !== 'boolean' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
let sink: (line: string) => void = (line) => process.stdout.write(line + '\n');

export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}
export function setLogLevel(level: Level): void {
  minLevel = level;
}

function emit(level: Level, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const record = { t: new Date().toISOString(), level, component, msg: scrubString(msg), ...(fields ? (redact(fields) as Record<string, unknown>) : {}) };
  sink(JSON.stringify(record));
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function logger(component: string): Logger {
  return {
    debug: (m, f) => emit('debug', component, m, f),
    info: (m, f) => emit('info', component, m, f),
    warn: (m, f) => emit('warn', component, m, f),
    error: (m, f) => emit('error', component, m, f),
  };
}

export function errMsg(e: unknown): string {
  return scrubString(e instanceof Error ? e.message : String(e)).slice(0, 1000);
}
