/**
 * Home Hub add-on entry point. Outbound only: Supervisor API + HA WebSocket (both via the internal
 * `supervisor` host) and HTTPS/gRPC to Home Hub (Firebase). No ports, no shell, no SSH.
 */
import {
  applyHumanResets,
  historyStore,
  isBlocked,
  pickAutoUpdate,
  protectedBackups,
  recordOutcome,
  RETENTION_EVERY_MS,
  type UpdateCandidate,
} from './autoUpdate.js';
import { CommandProcessor } from './commands.js';
import { ADDON_VERSION, DATA_DIR, FatalConfigError, loadOptions } from './config.js';
import { HomeSettings, PATHS, type HomeState } from './contract.js';
import { FirestoreHubStore, HubSession } from './firestoreStore.js';
import { HaWebSocket, type HaRegistry } from './haWs.js';
import { errMsg, logger, registerSecret } from './log.js';
import { EntityMirror } from './mirror.js';
import { ensurePaired } from './pairing.js';
import { AddonFlapTracker, collectPiStatus, cpuSampler, entityUpdateCandidates, readSysCpuTemp, sampleAddonStates } from './piStatus.js';
import { pruneBackups } from './retention.js';
import { RuleEngine } from './rules.js';
import { relaySportsFeed, SPORTS_LIVE_MS } from './sportsFeed.js';
import { createSupervisorClient } from './supervisor.js';
import { supervisorBusy, type UpdateDeps } from './updateFlow.js';
import { fileUpdateStateStore } from './updateState.js';
import { iso, retryForever, sleep } from './util.js';

const log = logger('main');

const HEARTBEAT_MS = 60_000;
const PI_STATUS_MS = 5 * 60_000;
const CATALOG_MS = 6 * 60 * 60_000;
/** After the Hub refuses an auto-update's audit doc, leave that target alone this long. */
const AUDIT_REFUSED_PAUSE_MS = 60 * 60_000;
const CPU_TEMP_SENSORS = ['sensor.processor_temperature', 'sensor.cpu_temperature', 'sensor.system_monitor_processor_temperature'];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

async function start(): Promise<void> {
  // ---- config (the only fatal errors) ----
  const options = loadOptions();
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new FatalConfigError('SUPERVISOR_TOKEN is missing (hassio_api / homeassistant_api must be enabled for this add-on).');
  registerSecret(token);
  log.info('Home Hub add-on starting', { version: ADDON_VERSION, hubUrl: options.hub_url });

  const sup = createSupervisorClient(token);
  const sysInfo = await retryForever(() => sup.get<{ supported?: boolean; machine_id?: string; hostname?: string; homeassistant?: string }>('/info'), {
    capMs: 60_000,
    onError: (e, _a, wait) => log.warn(`Supervisor not reachable; retrying in ${Math.round(wait / 1000)}s`, { error: errMsg(e) }),
  });
  if (sysInfo.supported === false) {
    log.warn('Supervisor reports this installation as unsupported (e.g. other containers on the host). Reporting it and continuing.');
  }
  // A human-readable name for Hub Settings: HA's location name, else the hostname.
  const haConfig = await sup.core<{ location_name?: string }>('/api/config').catch(() => null);
  const haInstance = (haConfig?.location_name || sysInfo.hostname || sysInfo.machine_id || 'Home Assistant').trim();
  const selfInfo = await sup.get<{ slug?: string }>('/addons/self/info').catch(() => null);
  const selfSlug = selfInfo?.slug ?? null;

  const device = await retryForever(
    () => ensurePaired({ dir: DATA_DIR, hubUrl: options.hub_url, pairingCode: options.pairing_code, haInstance, addonVersion: ADDON_VERSION }),
    {
      isFatal: (e) => e instanceof FatalConfigError,
      onError: (e, _a, wait) => log.warn(`Pairing request failed; retrying in ${Math.round(wait / 1000)}s`, { error: errMsg(e) }),
    },
  );

  const session = new HubSession(options.hub_url, device);
  await session.connect();
  const store = new FirestoreHubStore(session);

  // ---- state ----
  let settings: HomeSettings | null = null;
  let lastError: string | null = null;
  let haVersion: string | null = sysInfo.homeassistant ?? null;
  let registry: HaRegistry | null = null;
  let stopping = false;
  const timers: ReturnType<typeof setInterval>[] = [];

  const ha = new HaWebSocket(token);
  const mirror = new EntityMirror(store);
  const rules = new RuleEngine((rule, entityId, state, atMs) => {
    log.info('Event rule fired', { ruleId: rule.id, entityId, state });
    store
      .add(PATHS.homeEvents, { ruleId: rule.id, entityId, state, at: iso(atMs), handled: false })
      .catch((e) => log.warn('Writing homeEvents failed', { ruleId: rule.id, error: errMsg(e) }));
  });
  const flaps = new AddonFlapTracker();
  const cpu = cpuSampler();
  cpu();
  const updateState = fileUpdateStateStore(DATA_DIR);
  const historyFile = historyStore(DATA_DIR);
  const history = historyFile.load();
  const saveHistory = () => {
    try {
      historyFile.save(history);
    } catch (e) {
      log.warn('Could not persist auto-update history', { error: errMsg(e) });
    }
  };
  /** target -> time until which auto-update leaves it alone (Hub refused the audit doc). */
  const auditPaused = new Map<string, number>();
  let autoRunning = false;

  const updateDeps: UpdateDeps = { sup, sleep, now: Date.now, state: updateState, ha };

  const cpuTemp = (): number | null => {
    const sys = readSysCpuTemp();
    if (sys !== null) return sys;
    for (const id of CPU_TEMP_SENSORS) {
      const v = Number(mirror.states.get(id)?.state);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };

  // ---- heartbeat ----
  const writeState = (online: boolean) => {
    const state: HomeState = { online, lastSeenAt: iso(Date.now()), addonVersion: ADDON_VERSION, haVersion, deviceId: device.deviceId, error: lastError };
    return store.set(PATHS.homeState, state as unknown as Record<string, unknown>);
  };
  const heartbeat = () => {
    writeState(true).catch((e) => log.warn('Heartbeat write failed', { error: errMsg(e) }));
    sampleAddonStates(sup, flaps, Date.now()).catch(() => {});
  };

  // ---- Pi status + auto-update ----
  let piRunning = false;
  let piTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshPi = async () => {
    if (piRunning || stopping) return;
    piRunning = true;
    try {
      const snap = await collectPiStatus({
        sup,
        now: Date.now,
        flaps,
        settings: () => settings,
        cpuTempC: cpuTemp,
        cpuPercent: cpu,
        blocked: (t) => isBlocked(history, t),
        entityUpdates: async () => {
          if (!ha.connected || !registry) return [];
          const platform = new Map(registry.entities.map((e) => [e.entity_id, e.platform]));
          return entityUpdateCandidates(await ha.getStates(), (id) => platform.get(id));
        },
      });
      if (snap.coreVersion) haVersion = snap.coreVersion;
      await store.set(PATHS.homePi, snap.status as unknown as Record<string, unknown>);
      if (settings) {
        if (Date.now() - (history.lastRetentionAt ?? 0) > RETENTION_EVERY_MS) scheduleRetention('daily');
        await maybeAutoUpdate(settings, snap.status.updates);
      }
    } catch (e) {
      log.warn('Pi status refresh failed', { error: errMsg(e) });
    } finally {
      piRunning = false;
    }
  };
  /** One auto-update at a time, in order (autoUpdate.ts), only when nothing else runs. */
  const maybeAutoUpdate = async (s: HomeSettings, updates: UpdateCandidate[]) => {
    if (autoRunning) return;
    const now = Date.now();
    for (const [t, until] of auditPaused) if (until <= now) auditPaused.delete(t);
    const pick = pickAutoUpdate({
      settings: s,
      candidates: updates,
      nowMs: now,
      history,
      selfSlug,
      locked: updateState.load() !== null || processor.busy,
      skip: new Set(auditPaused.keys()),
    });
    if (!pick) return;
    const busy = await supervisorBusy(sup);
    if (busy) {
      log.info('Supervisor is busy; auto-update waits for the next poll', { target: pick.target, job: busy });
      return;
    }
    autoRunning = true;
    log.info('Auto-updating', { target: pick.target, version: pick.latest, mode: s.autoUpdateMode });
    void processor
      .runLocalUpdate(pick.target)
      .then((res) => {
        if (res === null) auditPaused.set(pick.target, Date.now() + AUDIT_REFUSED_PAUSE_MS);
      })
      .finally(() => {
        autoRunning = false;
      });
  };

  /** Keep the newest settings.backupRetention 'hub-' backups. Serialized with commands/updates. */
  const scheduleRetention = (why: string) => {
    history.lastRetentionAt = Date.now();
    saveHistory();
    processor.exclusive(async () => {
      const keep = settings?.backupRetention ?? 5;
      const inFlight = updateState.load()?.backupName;
      const protect = new Set([...protectedBackups(history), ...(inFlight ? [inFlight] : [])]);
      try {
        const r = await pruneBackups(sup, keep, protect);
        log.info('Backup retention done', { why, keep, deleted: r.deleted.length });
      } catch (e) {
        log.warn('Backup retention failed', { why, error: errMsg(e) });
      }
    });
  };

  const schedulePi = (ms: number) => {
    if (piTimer) clearTimeout(piTimer);
    piTimer = setTimeout(() => void refreshPi(), ms);
  };

  // ---- commands ----
  const processor = new CommandProcessor({
    store,
    ha,
    sup,
    update: updateDeps,
    settings: () => settings,
    deviceClassOf: (id) => mirror.deviceClassOf(id),
    selfSlug: () => selfSlug,
    now: Date.now,
    afterCommand: () => schedulePi(5_000),
    onUpdateResult: (target, res, auto) => {
      if (res.status === 'done') {
        if (history.targets[target]) {
          recordOutcome(history, target, true, Date.now(), null);
          saveHistory();
        }
        if (res.backupName) scheduleRetention(`after updating ${target}`);
      } else if (auto && !res.transient) {
        recordOutcome(history, target, false, Date.now(), res.backupName);
        saveHistory();
        if (isBlocked(history, target)) {
          log.warn('Auto-update of this target failed twice in a row; stopped until Retry in Home Hub', { target, backupName: res.backupName });
        } else {
          log.warn('Auto-update failed; next try in 6 h at the earliest', { target, backupName: res.backupName });
        }
      }
    },
  });

  // An update that was in progress when we last stopped (Core restart, OS reboot, Supervisor restart):
  // finish it before anything else runs.
  const pending = updateState.load();
  if (pending) {
    void processor.resume(pending).then((res) => {
      log.info('In-flight update finished', { target: pending.target, status: res.status, result: res.result, error: res.error });
      schedulePi(5_000);
    });
  }

  // ---- catalog ----
  const refreshCatalog = async () => {
    if (!ha.connected) return;
    try {
      registry = await ha.getRegistry();
      mirror.setRegistry(registry);
    } catch (e) {
      log.warn('Reading HA registries failed; catalog without areas', { error: errMsg(e) });
    }
    try {
      const n = await mirror.catalog(registry);
      log.info('Catalog written', { domains: n });
    } catch (e) {
      log.warn('Catalog write failed', { error: errMsg(e) });
    }
  };

  // ---- settings/home -> allowlists, rules; then start taking commands ----
  let commandsUnsub: (() => void) | null = null;
  const settingsUnsub = store.watchDoc(PATHS.settingsHome, (data) => {
    const parsed = HomeSettings.safeParse(data ?? {});
    if (!parsed.success) {
      lastError = 'settings/home does not match the contract; keeping the previous settings';
      log.warn(lastError);
      return;
    }
    settings = parsed.data;
    mirror.setAllowlist(settings.entities);
    rules.setRules(settings.rules);
    // Retry pressed (or auto-update switched off) for a blocked target: forget its failures.
    const released = applyHumanResets(history, settings);
    if (released.length) {
      saveHistory();
      log.info('Auto-update failures cleared by a household member', { targets: released });
      schedulePi(5_000);
    }
    // Adopt states that already match new/changed rules (no fire for an episode already under way).
    if (ha.connected) {
      ha.getStates()
        .then((states) => rules.seed(states.map((x) => ({ entityId: x.entity_id, state: x.state, lastChangedMs: Date.parse(x.last_changed) || Date.now() }))))
        .catch(() => {});
    }
    log.info('Settings loaded', { entities: settings.entities.length, services: settings.services.length, rules: settings.rules.length });
    if (!commandsUnsub) commandsUnsub = store.watchApprovedCommands((ids) => processor.onApproved(ids));
  });

  // ---- Home Assistant ----
  let firstReady = true;
  ha.on('ready', (version) => {
    if (version) haVersion = version;
    if (lastError?.startsWith('Home Assistant')) lastError = null;
    void (async () => {
      try {
        const states = await ha.getStates();
        mirror.loadStates(states);
        rules.seed(states.map((s) => ({ entityId: s.entity_id, state: s.state, lastChangedMs: Date.parse(s.last_changed) || Date.now() })));
        if (firstReady) {
          firstReady = false;
          await refreshCatalog();
        }
      } catch (e) {
        log.warn('Loading HA states failed', { error: errMsg(e) });
      }
    })();
  });
  ha.on('disconnected', () => {
    lastError = 'Home Assistant websocket disconnected';
  });
  ha.on('state_changed', (entityId, oldState, newState) => {
    mirror.onStateChanged(entityId, newState);
    rules.onStateChange(entityId, oldState?.state ?? null, newState?.state ?? null);
  });
  ha.start();

  heartbeat();
  void refreshPi();
  timers.push(setInterval(heartbeat, HEARTBEAT_MS));
  timers.push(setInterval(() => void refreshPi(), PI_STATUS_MS));
  timers.push(setInterval(() => void refreshCatalog(), CATALOG_MS));
  void relaySportsFeed(store);
  timers.push(setInterval(() => void relaySportsFeed(store), SPORTS_LIVE_MS));

  // ---- graceful shutdown ----
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Received ${signal}; going offline`);
    for (const t of timers) clearInterval(t);
    if (piTimer) clearTimeout(piTimer);
    settingsUnsub();
    commandsUnsub?.();
    rules.stop();
    ha.stop();
    await withTimeout(mirror.flush(), 3_000);
    mirror.stop();
    await withTimeout(
      writeState(false).catch((e) => log.warn('Final state write failed', { error: errMsg(e) })),
      5_000,
    );
    await withTimeout(session.close(), 2_000);
    process.exit(0);
  };
  shutdownHook = shutdown;
}

/** Set once everything is running; before that a signal just exits cleanly (nothing to flush yet). */
let shutdownHook: ((signal: string) => Promise<void>) | null = null;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shutdownHook) void shutdownHook(sig);
    else process.exit(0);
  });
}
process.on('unhandledRejection', (e) => log.error('Unhandled rejection', { error: errMsg(e) }));

start().catch((e) => {
  if (e instanceof FatalConfigError) {
    log.error(`Fatal configuration error: ${errMsg(e)}`);
    process.exit(1);
  }
  // Startup steps retry forever, so reaching here is a bug: log it and exit cleanly
  // (a non-zero exit is reserved for fatal configuration errors).
  log.error('Unexpected startup error', { error: errMsg(e) });
  setTimeout(() => process.exit(0), 1_000);
});
