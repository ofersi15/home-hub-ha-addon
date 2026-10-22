/**
 * Minimal Supervisor API client (http://supervisor, Bearer SUPERVISOR_TOKEN).
 *
 * Defense in depth: on top of the Supervisor's own role check (hassio_role: manager), every call is
 * matched against a small allowlist of paths this add-on needs. Anything else (host power actions,
 * uninstalling add-ons, OS data-disk actions, ...) is refused here before a request is made.
 * Uses node:http (no global fetch) so long-running calls (updates, backups) have no hidden timeout.
 */
import http from 'node:http';

const SLUG = '[a-z0-9_]+';
/** Supervisor backup slugs: first 8 hex chars of a sha1. */
const BACKUP_SLUG = '[0-9a-f]{8}';

const GET_ALLOW: RegExp[] = [
  /^\/info$/,
  /^\/(host|os|core|supervisor)\/info$/,
  /^\/(core|supervisor)\/stats$/,
  /^\/available_updates$/,
  /^\/resolution\/info$/,
  /^\/addons$/,
  new RegExp(`^/addons/${SLUG}/(info|stats)$`),
  /^\/backups$/,
  new RegExp(`^/backups/${BACKUP_SLUG}/info$`),
  /^\/jobs\/info$/,
  /^\/jobs\/[0-9a-f-]{8,64}$/,
];

const POST_ALLOW: RegExp[] = [
  /^\/backups\/new\/(full|partial)$/,
  /^\/(core|os|supervisor)\/update$/,
  new RegExp(`^/store/addons/${SLUG}/update$`),
  new RegExp(`^/addons/${SLUG}/restart$`),
  // Start an add-on once after its own update if it does not come back (updateFlow.ts).
  new RegExp(`^/addons/${SLUG}/start$`),
  // Apply a Supervisor resolution suggestion (uuid4 hex). updateFlow.ts only applies execute_restart,
  // and execute_reboot once to boot an OS update we installed or found installed-but-not-booted;
  // see DECISIONS.md D10 and D14. No host power endpoint is allowlisted.
  /^\/resolution\/suggestion\/[0-9a-f]{32}$/,
];

/** Retention of our own 'hub-' backups only (retention.ts checks the name via /backups/<slug>/info first). */
const DELETE_ALLOW: RegExp[] = [new RegExp(`^/backups/${BACKUP_SLUG}$`)];

/** HA Core REST (proxied by the Supervisor at /core/api/...). Read-only probes only. */
const CORE_GET_ALLOW: RegExp[] = [/^\/api\/$/, /^\/api\/config$/];

export type Method = 'GET' | 'POST' | 'DELETE';

export function isAllowed(method: Method, path: string): boolean {
  const list = method === 'GET' ? GET_ALLOW : method === 'POST' ? POST_ALLOW : DELETE_ALLOW;
  return list.some((re) => re.test(path));
}

export class SupervisorError extends Error {
  override name = 'SupervisorError';
  constructor(
    message: string,
    /** 'api' = Supervisor answered with an error; 'network' = connection dropped/timed out; 'denied' = refused locally. */
    readonly kind: 'api' | 'network' | 'denied',
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface SupervisorApi {
  get<T = Record<string, unknown>>(path: string): Promise<T>;
  post<T = Record<string, unknown>>(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  del<T = Record<string, unknown>>(path: string): Promise<T>;
  /** GET on HA Core's REST API via the Supervisor proxy (e.g. '/api/'). Returns the raw JSON. */
  core<T = Record<string, unknown>>(path: string): Promise<T>;
}

interface RawResponse {
  status: number;
  body: string;
}

function request(host: string, token: string, method: string, path: string, body: unknown, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host,
        port: 80,
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(new SupervisorError(`${method} ${path}: ${e.message}`, 'network')));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', (e) => reject(new SupervisorError(`${method} ${path}: ${e.message}`, 'network')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function createSupervisorClient(token: string, host = 'supervisor'): SupervisorApi {
  const call = async <T>(method: Method, path: string, body: unknown, timeoutMs: number): Promise<T> => {
    if (!isAllowed(method, path)) throw new SupervisorError(`${method} ${path} is not allowlisted in this add-on`, 'denied');
    const res = await request(host, token, method, path, body, timeoutMs);
    let json: { result?: string; message?: string; data?: unknown } = {};
    try {
      json = res.body ? (JSON.parse(res.body) as typeof json) : {};
    } catch {
      /* non-JSON */
    }
    if (res.status >= 400 || json.result === 'error') {
      throw new SupervisorError(`${method} ${path}: ${json.message ?? `HTTP ${res.status}`}`, 'api', res.status);
    }
    return (json.data ?? {}) as T;
  };
  return {
    get: (path) => call('GET', path, undefined, 60_000),
    post: (path, body, opts) => call('POST', path, body ?? {}, opts?.timeoutMs ?? 60_000),
    del: (path) => call('DELETE', path, undefined, 60_000),
    core: async <T>(path: string): Promise<T> => {
      if (!CORE_GET_ALLOW.some((re) => re.test(path))) throw new SupervisorError(`core GET ${path} is not allowlisted`, 'denied');
      const res = await request(host, token, 'GET', `/core${path}`, undefined, 30_000);
      if (res.status >= 400) throw new SupervisorError(`core GET ${path}: HTTP ${res.status}`, 'api', res.status);
      try {
        return JSON.parse(res.body) as T;
      } catch {
        throw new SupervisorError(`core GET ${path}: non-JSON response`, 'api', res.status);
      }
    },
  };
}
