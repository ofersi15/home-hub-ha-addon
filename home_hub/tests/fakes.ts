import type { ClaimDecision, HubStore, Unsubscribe } from '../src/store.js';
import { SupervisorError, isAllowed, type SupervisorApi } from '../src/supervisor.js';

/** In-memory HubStore. `docs` is keyed by full path. */
export class FakeStore implements HubStore {
  docs = new Map<string, Record<string, unknown>>();
  writes: { op: string; path: string; data?: Record<string, unknown> }[] = [];
  failAdd = false;
  private nextId = 1;

  async set(path: string, data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    this.writes.push({ op: 'set', path, data });
    this.docs.set(path, opts?.merge ? { ...(this.docs.get(path) ?? {}), ...data } : { ...data });
  }
  async update(path: string, fields: Record<string, unknown>): Promise<void> {
    this.writes.push({ op: 'update', path, data: fields });
    const cur = this.docs.get(path);
    if (!cur) throw new Error(`no doc ${path}`);
    this.docs.set(path, { ...cur, ...fields });
  }
  async remove(path: string): Promise<void> {
    this.writes.push({ op: 'remove', path });
    this.docs.delete(path);
  }
  async add(collectionPath: string, data: Record<string, unknown>): Promise<string> {
    if (this.failAdd) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    const id = `auto${this.nextId++}`;
    this.writes.push({ op: 'add', path: `${collectionPath}/${id}`, data });
    this.docs.set(`${collectionPath}/${id}`, { ...data });
    return id;
  }
  watchDoc(): Unsubscribe {
    return () => {};
  }
  watchApprovedCommands(): Unsubscribe {
    return () => {};
  }
  async claim(id: string, decide: (raw: Record<string, unknown> | null) => ClaimDecision): Promise<ClaimDecision> {
    const path = `hub/main/homeCommands/${id}`;
    const d = decide(this.docs.get(path) ?? null);
    if (d.action !== 'skip') await this.update(path, d.fields);
    return d;
  }
}

type Handler = unknown | ((body?: unknown) => unknown);

/** Scriptable Supervisor: GET/POST handlers by path; records every call in order. */
export class FakeSupervisor implements SupervisorApi {
  calls: { method: string; path: string; body?: unknown }[] = [];
  gets = new Map<string, Handler>();
  posts = new Map<string, Handler>();
  cores = new Map<string, Handler>();

  private resolve(map: Map<string, Handler>, method: string, path: string, body?: unknown): unknown {
    if (!map.has(path)) throw new SupervisorError(`${method} ${path}: not mocked`, 'api', 404);
    const h = map.get(path);
    return typeof h === 'function' ? (h as (b?: unknown) => unknown)(body) : h;
  }

  async get<T>(path: string): Promise<T> {
    if (!isAllowed('GET', path)) throw new SupervisorError(`GET ${path} not allowlisted`, 'denied');
    this.calls.push({ method: 'GET', path });
    return this.resolve(this.gets, 'GET', path) as T;
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    if (!isAllowed('POST', path)) throw new SupervisorError(`POST ${path} not allowlisted`, 'denied');
    this.calls.push({ method: 'POST', path, body });
    return this.resolve(this.posts, 'POST', path, body) as T;
  }
  async core<T>(path: string): Promise<T> {
    this.calls.push({ method: 'CORE', path });
    return this.resolve(this.cores, 'CORE', path) as T;
  }
  posted(): string[] {
    return this.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  }
}

/** Fake clock + sleep that advances the clock instantly. */
export function fakeTime(start = Date.parse('2026-10-22T12:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
