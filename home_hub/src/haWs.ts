/**
 * Home Assistant WebSocket client (ws://supervisor/core/websocket, auth = SUPERVISOR_TOKEN).
 * Subscribes to state_changed, sends call_service and registry/state queries. Reconnects with
 * backoff and keeps the connection alive with pings.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { errMsg, logger } from './log.js';
import { backoffMs } from './util.js';

const log = logger('ha');

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated?: string;
}

export interface HaRegistry {
  areas: { area_id: string; name: string }[];
  devices: { id: string; area_id: string | null }[];
  entities: {
    entity_id: string;
    area_id: string | null;
    device_id: string | null;
    name: string | null;
    original_name?: string | null;
    device_class?: string | null;
    original_device_class?: string | null;
    /** Integration that provides the entity ('hassio', 'hacs', 'zwave_js', ...). */
    platform?: string;
  }[];
}

/** A Repairs issue (WS `repairs/list_issues`). */
export interface HaIssue {
  domain: string;
  issue_id: string;
  translation_key?: string | null;
  ignored?: boolean;
}

/** What the rest of the add-on needs from HA (mocked in tests). */
export interface HaApi {
  callService(domain: string, service: string, data: Record<string, unknown>, entityId: string, timeoutMs?: number): Promise<void>;
  getStates(): Promise<HaState[]>;
  getRegistry(): Promise<HaRegistry>;
}

export interface HaEvents {
  ready: [haVersion: string | null];
  state_changed: [entityId: string, oldState: HaState | null, newState: HaState | null];
  disconnected: [];
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class HaWebSocket extends EventEmitter<HaEvents> implements HaApi {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private attempt = 0;
  private stopped = false;
  private authed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  haVersion: string | null = null;

  constructor(
    private readonly token: string,
    private readonly url = 'ws://supervisor/core/websocket',
  ) {
    super();
  }

  get connected(): boolean {
    return this.authed;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown();
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    const ws = new WebSocket(this.url, { handshakeTimeout: 15_000, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
    ws.on('error', (e) => log.warn('HA websocket error', { error: errMsg(e) }));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      const wasAuthed = this.authed;
      this.teardown();
      this.ws = null;
      if (wasAuthed) this.emit('disconnected');
      if (this.stopped) return;
      const wait = backoffMs(this.attempt++, 1000, 60_000);
      log.warn(`HA websocket closed; reconnecting in ${Math.round(wait / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.open(), wait);
    });
  }

  private teardown(): void {
    this.authed = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('HA websocket disconnected'));
    }
    this.pending.clear();
  }

  private onMessage(ws: WebSocket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'auth_required':
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        return;
      case 'auth_invalid':
        log.error('HA rejected the Supervisor token (auth_invalid)');
        ws.close();
        return;
      case 'auth_ok':
        this.haVersion = typeof msg.ha_version === 'string' ? msg.ha_version : null;
        this.authed = true;
        this.attempt = 0;
        this.startPing(ws);
        this.request({ type: 'subscribe_events', event_type: 'state_changed' })
          .then(() => {
            log.info('Connected to Home Assistant', { haVersion: this.haVersion });
            this.emit('ready', this.haVersion);
          })
          .catch((e) => {
            log.error('Subscribing to state_changed failed', { error: errMsg(e) });
            ws.close();
          });
        return;
      case 'pong':
        this.awaitingPong = false;
        this.settle(msg);
        return;
      case 'result':
        this.settle(msg);
        return;
      case 'event': {
        const ev = msg.event as { event_type?: string; data?: { entity_id?: string; old_state?: HaState | null; new_state?: HaState | null } } | undefined;
        if (ev?.event_type === 'state_changed' && ev.data?.entity_id) {
          this.emit('state_changed', ev.data.entity_id, ev.data.old_state ?? null, ev.data.new_state ?? null);
        }
        return;
      }
      default:
        return;
    }
  }

  private settle(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : -1;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.type === 'pong' || msg.success === true) p.resolve(msg.result ?? null);
    else {
      const err = msg.error as { code?: string; message?: string } | undefined;
      p.reject(new Error(`HA error: ${err?.code ?? 'unknown'} ${err?.message ?? ''}`.trim()));
    }
  }

  private startPing(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (this.awaitingPong) {
        log.warn('HA websocket ping timed out; reconnecting');
        ws.terminate();
        return;
      }
      this.awaitingPong = true;
      this.request({ type: 'ping' }).catch(() => {});
    }, 30_000);
  }

  request<T = unknown>(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || !this.authed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('HA websocket not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA request ${String(payload.type)} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  async callService(domain: string, service: string, data: Record<string, unknown>, entityId: string, timeoutMs = 30_000): Promise<void> {
    await this.request({ type: 'call_service', domain, service, service_data: data, target: { entity_id: entityId } }, timeoutMs);
  }

  async listIssues(): Promise<HaIssue[]> {
    const r = await this.request<{ issues?: HaIssue[] }>({ type: 'repairs/list_issues' });
    return r?.issues ?? [];
  }

  getStates(): Promise<HaState[]> {
    return this.request<HaState[]>({ type: 'get_states' }, 60_000);
  }

  async getRegistry(): Promise<HaRegistry> {
    const [areas, devices, entities] = await Promise.all([
      this.request<HaRegistry['areas']>({ type: 'config/area_registry/list' }, 60_000),
      this.request<HaRegistry['devices']>({ type: 'config/device_registry/list' }, 60_000),
      this.request<HaRegistry['entities']>({ type: 'config/entity_registry/list' }, 60_000),
    ]);
    return { areas, devices, entities };
  }
}
