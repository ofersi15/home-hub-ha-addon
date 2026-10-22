/**
 * Typed copy of the Home Hub <-> add-on contract.
 * Source of truth: ofersi15/home-hub `shared/schemas/home.ts` (+ `shared/schemas/common.ts`).
 * Keep these shapes identical; tests/contract.test.ts pins the important invariants.
 *
 * Firestore layout (all under hub/main):
 *   home/state                HomeState   (add-on writes)
 *   home/pi                   PiStatus    (add-on writes)
 *   homeEntities/{entityId}   HomeEntity  (add-on writes)
 *   homeCatalog/{domain}      HomeCatalog (add-on writes)
 *   homeCommands/{id}         HomeCommand (Hub creates; add-on claims + completes)
 *   homeEvents/{id}           HomeEvent   (add-on writes)
 *   settings/home             HomeSettings (household edits; add-on reads)
 */
import { z } from 'zod';

// ---- common.ts ----
export const IsoDateTime = z.iso.datetime({ offset: true });
export const ActorSchema = z.string().regex(/^(user:(ofer|arielle)|agent:[a-z0-9_-]+|system:[a-zA-Z0-9_-]+|import)$/);
export type Actor = z.infer<typeof ActorSchema>;

// ---- home.ts ----
export const SENSITIVE_DOMAINS = ['lock', 'alarm_control_panel', 'cover', 'garage_door', 'siren', 'valve'] as const;
export const SENSITIVE_COVER_CLASSES = ['garage', 'gate', 'door'] as const;

export const EntityId = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/);
export const ServiceName = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/);

export const HomeEntity = z.object({
  entityId: EntityId,
  domain: z.string(),
  name: z.string().max(200),
  state: z.string().max(255),
  attributes: z.record(z.string(), z.unknown()).default({}),
  area: z.string().max(100).nullable().default(null),
  lastChanged: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HomeEntity = z.infer<typeof HomeEntity>;

export const HomeCatalog = z.object({
  domain: z.string(),
  entities: z
    .array(z.object({ entityId: EntityId, name: z.string(), area: z.string().nullable().default(null), deviceClass: z.string().nullable().default(null) }))
    .max(2000),
  updatedAt: IsoDateTime,
});
export type HomeCatalog = z.infer<typeof HomeCatalog>;

export const HomeState = z.object({
  online: z.boolean(),
  lastSeenAt: IsoDateTime,
  addonVersion: z.string(),
  haVersion: z.string().nullable().default(null),
  deviceId: z.string(),
  error: z.string().nullable().default(null),
});
export type HomeState = z.infer<typeof HomeState>;

export const UpdateInfo = z.object({
  target: z.string(),
  name: z.string(),
  installed: z.string(),
  latest: z.string(),
  updateAvailable: z.boolean(),
  releaseNotesUrl: z.string().nullable().default(null),
});
export type UpdateInfo = z.infer<typeof UpdateInfo>;

export const AddonInfo = z.object({
  slug: z.string(),
  name: z.string(),
  state: z.enum(['started', 'stopped', 'error', 'unknown']),
  version: z.string(),
  updateAvailable: z.boolean(),
  recentRestarts: z.number().int().min(0).default(0),
  autoUpdatePolicy: z.enum(['off', 'auto']).default('off'),
  /** Supervisor boot setting. 'auto' = expected to run, so 'stopped' alerts. null = unknown. */
  boot: z.enum(['auto', 'manual']).nullable().default(null),
});
export type AddonInfo = z.infer<typeof AddonInfo>;

export const PiStatus = z.object({
  cpuTempC: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  diskUsedPercent: z.number().nullable(),
  diskFreeGb: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
  updates: z.array(UpdateInfo).default([]),
  addons: z.array(AddonInfo).default([]),
  lastBackup: z.object({ slug: z.string(), name: z.string(), date: IsoDateTime }).nullable().default(null),
  /** Supervisor /resolution/info + /supervisor/info: supported/healthy flags and reasons. */
  supervisor: z
    .object({
      supported: z.boolean(),
      healthy: z.boolean(),
      unsupportedReasons: z.array(z.string()).default([]),
      unhealthyReasons: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  updatedAt: IsoDateTime,
});
export type PiStatus = z.infer<typeof PiStatus>;

export const HomeCommandKind = z.enum(['call_service', 'backup', 'update', 'restart_addon']);
export type HomeCommandKind = z.infer<typeof HomeCommandKind>;

export const HomeCommandStatus = z.enum(['pending_approval', 'approved', 'claimed', 'done', 'failed', 'rejected', 'expired']);
export type HomeCommandStatus = z.infer<typeof HomeCommandStatus>;

export const HomeCommand = z.object({
  kind: HomeCommandKind,
  service: ServiceName.nullable().default(null),
  entityId: EntityId.nullable().default(null),
  data: z.record(z.string(), z.unknown()).default({}),
  target: z.string().nullable().default(null),
  status: HomeCommandStatus,
  requestedBy: ActorSchema,
  approvedBy: ActorSchema.nullable().default(null),
  sensitive: z.boolean().default(false),
  createdAt: IsoDateTime,
  approvedAt: IsoDateTime.nullable().default(null),
  claimedAt: IsoDateTime.nullable().default(null),
  finishedAt: IsoDateTime.nullable().default(null),
  result: z.string().max(2000).nullable().default(null),
  error: z.string().max(2000).nullable().default(null),
  backupName: z.string().nullable().default(null),
});
export type HomeCommand = z.infer<typeof HomeCommand>;

export const HomeEventRule = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().max(100),
  entityId: EntityId,
  toState: z.string().max(100),
  forMinutes: z.number().int().min(0).max(1440).default(0),
  action: z.enum(['notify', 'task']),
  message: z.string().max(200),
  enabled: z.boolean().default(true),
});
export type HomeEventRule = z.infer<typeof HomeEventRule>;

export const HomeEvent = z.object({
  ruleId: z.string(),
  entityId: EntityId,
  state: z.string(),
  at: IsoDateTime,
  handled: z.boolean().default(false),
});
export type HomeEvent = z.infer<typeof HomeEvent>;

export const HomeSettings = z.object({
  entities: z.array(EntityId).max(200).default([]),
  pinned: z.array(EntityId).max(30).default([]),
  services: z.array(ServiceName).max(100).default(['light.turn_on', 'light.turn_off', 'switch.turn_on', 'switch.turn_off']),
  rules: z.array(HomeEventRule).max(50).default([]),
  autoUpdate: z.record(z.string(), z.boolean()).default({}),
  autoUpdateWindow: z.object({ start: z.string(), end: z.string() }).default({ start: '03:00', end: '05:00' }),
  alerts: z
    .object({ diskPercent: z.number().default(85), cpuTempC: z.number().default(80), offlineMinutes: z.number().default(10) })
    .default({ diskPercent: 85, cpuTempC: 80, offlineMinutes: 10 }),
});
export type HomeSettings = z.infer<typeof HomeSettings>;

export function isSensitive(entityId: string | null, deviceClass?: string | null): boolean {
  if (!entityId) return false;
  const domain = entityId.split('.')[0] ?? '';
  if (domain === 'cover') return deviceClass != null && (SENSITIVE_COVER_CLASSES as readonly string[]).includes(deviceClass);
  return (SENSITIVE_DOMAINS as readonly string[]).includes(domain);
}

// ---- Wire protocol: pairing + device token ----
export const HOME_API = {
  /** Unsigned: redeem a one-time pairing code for a device id + key. */
  pair: '/api/home/pair',
  /** HMAC-signed: exchange the device key for a Firebase custom token. */
  token: '/api/home/token',
} as const;

export const HomePairRequest = z.object({
  code: z.string().min(1).max(40),
  /** Free text that names the HA install in Hub Settings (e.g. its location name). */
  haInstance: z.string().trim().min(1).max(200),
  addonVersion: z.string().trim().min(1).max(50),
});
export type HomePairRequest = z.infer<typeof HomePairRequest>;

/** deviceKey: 32 bytes base64url (43 chars); the add-on uses the 43-char STRING (UTF-8) as the HMAC key. */
export const HomePairResponse = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9]{20}$/),
  deviceKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type HomePairResponse = z.infer<typeof HomePairResponse>;

/** X-Home-Signature = hex HMAC-SHA256(deviceKey, homeTokenSigningString(timestamp)); body not signed. */
export function homeTokenSigningString(timestamp: string): string {
  return `${timestamp}.POST.${HOME_API.token}.`;
}

export const HomeTokenResponse = z.object({
  customToken: z.string(),
  firebaseConfig: z.object({ apiKey: z.string(), authDomain: z.string(), projectId: z.string(), appId: z.string() }),
});
export type HomeTokenResponse = z.infer<typeof HomeTokenResponse>;

/** Updates that always need Ofer's explicit approval (never auto-updated). */
export const CORE_UPDATE_TARGETS = ['core', 'os', 'supervisor'] as const;
export const isCoreTarget = (target: string) => (CORE_UPDATE_TARGETS as readonly string[]).includes(target);

// ---- Firestore paths (shared/paths.ts: everything under hub/main) ----
export const HUB = 'hub/main';
export const PATHS = {
  homeState: `${HUB}/home/state`,
  homePi: `${HUB}/home/pi`,
  homeEntities: `${HUB}/homeEntities`,
  homeEntity: (entityId: string) => `${HUB}/homeEntities/${entityId}`,
  homeCatalog: (domain: string) => `${HUB}/homeCatalog/${domain}`,
  homeCommands: `${HUB}/homeCommands`,
  homeCommand: (id: string) => `${HUB}/homeCommands/${id}`,
  homeEvents: `${HUB}/homeEvents`,
  settingsHome: `${HUB}/settings/home`,
} as const;

/** Commands not claimed within this window are marked `expired` (stale button presses never fire later). */
export const COMMAND_TTL_MS = 10 * 60 * 1000;
/** Our own actor id for locally created (auto-update) commands. */
export const ADDON_ACTOR = 'system:addon';
/** Update targets that are never auto-updated and always need a human (Ofer) approval. */
export const PLATFORM_TARGETS = CORE_UPDATE_TARGETS;
