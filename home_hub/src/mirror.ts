/**
 * Entity mirror: allowlisted entities -> homeEntities/{entityId} (throttled, coalesced, filtered),
 * plus the full catalog -> homeCatalog/{domain} for the Hub's entity picker.
 * Keeps a cache of ALL current states (used for device classes and the CPU temperature fallback).
 */
import { filterAttributes } from './attributes.js';
import { PATHS, type HomeCatalog, type HomeEntity } from './contract.js';
import type { HaRegistry, HaState } from './haWs.js';
import { errMsg, logger } from './log.js';
import type { HubStore } from './store.js';
import { CoalescingThrottle } from './throttle.js';
import { iso } from './util.js';

const log = logger('mirror');
export const ENTITY_WRITE_INTERVAL_MS = 5_000;

function toIso(s: string | undefined, fallback: number): string {
  const t = s ? Date.parse(s) : NaN;
  return iso(Number.isFinite(t) ? t : fallback);
}

export function areaLookup(reg: HaRegistry): Map<string, string | null> {
  const areaName = new Map(reg.areas.map((a) => [a.area_id, a.name]));
  const deviceArea = new Map(reg.devices.map((d) => [d.id, d.area_id]));
  const out = new Map<string, string | null>();
  for (const e of reg.entities) {
    const areaId = e.area_id ?? (e.device_id ? (deviceArea.get(e.device_id) ?? null) : null);
    out.set(e.entity_id, areaId ? (areaName.get(areaId) ?? null) : null);
  }
  return out;
}

export function toHomeEntity(s: HaState, area: string | null, nowMs: number): HomeEntity {
  const name = typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : s.entity_id;
  return {
    entityId: s.entity_id,
    domain: s.entity_id.split('.')[0] ?? '',
    name: name.slice(0, 200),
    state: String(s.state).slice(0, 255),
    attributes: filterAttributes(s.attributes),
    area: area ? area.slice(0, 100) : null,
    lastChanged: toIso(s.last_changed, nowMs),
    updatedAt: iso(nowMs),
  };
}

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

export function buildCatalog(states: HaState[], reg: HaRegistry | null, nowMs: number): HomeCatalog[] {
  const areas = reg ? areaLookup(reg) : new Map<string, string | null>();
  const regByEntity = new Map((reg?.entities ?? []).map((e) => [e.entity_id, e]));
  const byDomain = new Map<string, HomeCatalog['entities']>();
  for (const s of states) {
    if (!ENTITY_ID_RE.test(s.entity_id)) continue;
    const domain = s.entity_id.split('.')[0] as string;
    const r = regByEntity.get(s.entity_id);
    const friendly = typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : null;
    const dc = typeof s.attributes?.device_class === 'string' ? s.attributes.device_class : (r?.device_class ?? r?.original_device_class ?? null);
    const list = byDomain.get(domain) ?? [];
    list.push({ entityId: s.entity_id, name: (r?.name ?? friendly ?? s.entity_id).slice(0, 200), area: areas.get(s.entity_id) ?? null, deviceClass: dc });
    byDomain.set(domain, list);
  }
  return [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, entities]) => ({
      domain,
      entities: entities.sort((a, b) => a.entityId.localeCompare(b.entityId)).slice(0, 2000),
      updatedAt: iso(nowMs),
    }));
}

export class EntityMirror {
  readonly states = new Map<string, HaState>();
  private areas = new Map<string, string | null>();
  private allow = new Set<string>();
  private throttle: CoalescingThrottle<HaState | null>;

  constructor(
    private readonly store: HubStore,
    private readonly now: () => number = Date.now,
    intervalMs = ENTITY_WRITE_INTERVAL_MS,
  ) {
    this.throttle = new CoalescingThrottle<HaState | null>(
      intervalMs,
      (entityId, s) => this.write(entityId, s),
      now,
      (key, e) => log.warn('Entity write failed', { entityId: key, error: errMsg(e) }),
    );
  }

  deviceClassOf(entityId: string): string | null {
    const dc = this.states.get(entityId)?.attributes?.device_class;
    return typeof dc === 'string' ? dc : null;
  }

  setRegistry(reg: HaRegistry): void {
    this.areas = areaLookup(reg);
  }

  /** New allowlist from settings/home: push newly allowed entities, delete docs of removed ones. */
  setAllowlist(entities: string[]): void {
    const next = new Set(entities);
    for (const old of this.allow) {
      if (!next.has(old)) {
        this.throttle.cancel(old);
        this.store.remove(PATHS.homeEntity(old)).catch((e) => log.warn('Removing un-allowlisted entity failed', { entityId: old, error: errMsg(e) }));
      }
    }
    const added = [...next].filter((e) => !this.allow.has(e));
    this.allow = next;
    for (const id of added) {
      const s = this.states.get(id);
      if (s) this.throttle.push(id, s);
    }
  }

  /** Full state load (start / reconnect): cache everything, mirror the allowlisted ones. */
  loadStates(states: HaState[]): void {
    this.states.clear();
    for (const s of states) this.states.set(s.entity_id, s);
    for (const id of this.allow) {
      const s = this.states.get(id);
      if (s) this.throttle.push(id, s);
    }
  }

  onStateChanged(entityId: string, newState: HaState | null): void {
    if (newState) this.states.set(entityId, newState);
    else this.states.delete(entityId);
    if (!this.allow.has(entityId)) return;
    if (newState) {
      this.throttle.push(entityId, newState);
    } else {
      // Entity deleted in HA (new_state null): drop its Hub copy so it doesn't linger as a stale tile.
      this.throttle.cancel(entityId);
      this.store.remove(PATHS.homeEntity(entityId)).catch((e) => log.warn('Removing deleted entity failed', { entityId, error: errMsg(e) }));
    }
  }

  async catalog(reg: HaRegistry | null): Promise<number> {
    const docs = buildCatalog([...this.states.values()], reg, this.now());
    for (const d of docs) await this.store.set(PATHS.homeCatalog(d.domain), d as unknown as Record<string, unknown>);
    return docs.length;
  }

  flush(): Promise<void> {
    return this.throttle.flushAll();
  }

  stop(): void {
    this.throttle.stop();
  }

  private async write(entityId: string, s: HaState | null): Promise<void> {
    if (!s || !this.allow.has(entityId)) return;
    const entity = toHomeEntity(s, this.areas.get(entityId) ?? null, this.now());
    await this.store.set(PATHS.homeEntity(entityId), entity as unknown as Record<string, unknown>);
  }
}
