/**
 * Command execution. The Hub writes homeCommands with status 'approved'; the add-on claims each one
 * in a transaction and re-validates it independently of the Hub:
 *  - expired: not claimed within 10 minutes of creation/approval -> 'expired', never executed;
 *  - call_service: service in settings.services AND entity in settings.entities;
 *  - sensitive (locks, alarm, garage/gate/door covers, sirens, valves): needs a human `approvedBy`;
 *  - Core/OS/Supervisor updates: need `approvedBy: user:ofer`;
 *  - only the four allowlisted kinds exist; nothing else can run.
 * Every outcome is written back on the command doc (result/error/finishedAt) = the audit trail.
 * Only transitions the Hub rules allow are used: approved -> claimed -> done | failed, or
 * approved -> expired. A refused command is claimed and failed with "Refused by the add-on: ...";
 * one flagged sensitive without a human approval is never claimed and is closed as expired.
 */
import {
  ADDON_ACTOR,
  COMMAND_TTL_MS,
  HomeCommand,
  isSensitive,
  PATHS,
  PLATFORM_TARGETS,
  SENSITIVE_DOMAINS,
  type HomeSettings,
} from './contract.js';
import { createBackup } from './backup.js';
import type { HaApi } from './haWs.js';
import { errMsg, logger } from './log.js';
import type { ClaimDecision, HubStore } from './store.js';
import type { SupervisorApi } from './supervisor.js';
import { parseTarget, runUpdate, type ExecResult, type UpdateDeps } from './updateFlow.js';
import { iso, nyParts, safeName, type Clock } from './util.js';

const log = logger('commands');

export type Validation = { ok: true } | { ok: false; status: 'rejected' | 'expired'; error: string };

export interface ValidationCtx {
  settings: HomeSettings;
  /** Live device_class of an entity (null if none / unknown). */
  deviceClassOf: (entityId: string) => string | null;
  nowMs: number;
  selfSlug: string | null;
}

const HUMAN = /^user:(ofer|arielle)$/;
/** Keys that would retarget a service call; the target is always exactly cmd.entityId. */
const TARGET_KEYS = ['entity_id', 'area_id', 'device_id', 'floor_id', 'label_id'];

export function hasHumanApproval(cmd: Pick<HomeCommand, 'approvedBy'>): boolean {
  return cmd.approvedBy != null && HUMAN.test(cmd.approvedBy);
}

export function isSensitiveCommand(cmd: HomeCommand, deviceClassOf: (entityId: string) => string | null): boolean {
  if (cmd.sensitive) return true;
  if (cmd.kind !== 'call_service') return false;
  const entityId = cmd.entityId;
  const dc = entityId ? deviceClassOf(entityId) : null;
  if (isSensitive(entityId, dc)) return true;
  // A cover whose class we can't see might be a garage door: treat as sensitive.
  if (entityId?.startsWith('cover.') && dc == null) return true;
  // Service domain counts too (e.g. lock.unlock), except cover.* which is decided by the entity's class.
  const svcDomain = cmd.service?.split('.')[0] ?? '';
  return svcDomain !== 'cover' && (SENSITIVE_DOMAINS as readonly string[]).includes(svcDomain);
}

export function validateCommand(cmd: HomeCommand, ctx: ValidationCtx): Validation {
  const reject = (error: string): Validation => ({ ok: false, status: 'rejected', error });

  const created = Date.parse(cmd.createdAt);
  const approved = cmd.approvedAt ? Date.parse(cmd.approvedAt) : NaN;
  const ref = Math.max(created, Number.isFinite(approved) ? approved : created);
  if (!Number.isFinite(ref) || ctx.nowMs - ref > COMMAND_TTL_MS) {
    return { ok: false, status: 'expired', error: 'Not claimed within 10 minutes; expired without running.' };
  }

  switch (cmd.kind) {
    case 'call_service': {
      if (!cmd.service || !cmd.entityId) return reject('call_service needs service and entityId.');
      if (!ctx.settings.services.includes(cmd.service)) return reject(`Service ${cmd.service} is not in the allowlist (Settings -> Home).`);
      if (!ctx.settings.entities.includes(cmd.entityId)) return reject(`Entity ${cmd.entityId} is not in the allowlist (Settings -> Home).`);
      if (isSensitiveCommand(cmd, ctx.deviceClassOf) && !hasHumanApproval(cmd)) {
        return reject(`${cmd.entityId} is sensitive and needs a household member's approval.`);
      }
      return { ok: true };
    }
    case 'backup':
      if (cmd.sensitive && !hasHumanApproval(cmd)) return reject('Sensitive command without human approval.');
      return { ok: true };
    case 'update': {
      if (!cmd.target || !parseTarget(cmd.target)) return reject('update needs a valid target (core, os, supervisor or an add-on slug).');
      if ((PLATFORM_TARGETS as readonly string[]).includes(cmd.target)) {
        if (cmd.approvedBy !== 'user:ofer') return reject(`Updating ${cmd.target} always needs Ofer's approval.`);
      } else if (cmd.sensitive && !hasHumanApproval(cmd)) {
        return reject('Sensitive command without human approval.');
      }
      return { ok: true };
    }
    case 'restart_addon': {
      const t = cmd.target;
      if (!t || !/^[a-z0-9_]+$/.test(t) || (PLATFORM_TARGETS as readonly string[]).includes(t)) return reject('restart_addon needs an add-on slug.');
      if (t === 'self' || t === ctx.selfSlug) return reject('The Home Hub add-on does not restart itself.');
      if (cmd.sensitive && !hasHumanApproval(cmd)) return reject('Sensitive command without human approval.');
      return { ok: true };
    }
    default:
      return reject('Unknown command kind.');
  }
}

export function serviceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!TARGET_KEYS.includes(k)) out[k] = v;
  return out;
}

export function backupNameFor(nowMs: number, reason: string | null | undefined): string {
  return `hub-${nyParts(nowMs).date}-${safeName(reason || 'manual')}`;
}

export interface ProcessorDeps {
  store: HubStore;
  ha: HaApi;
  sup: SupervisorApi;
  update: UpdateDeps;
  settings: () => HomeSettings | null;
  deviceClassOf: (entityId: string) => string | null;
  selfSlug: () => string | null;
  now: Clock;
  /** Called after each executed command (refresh Pi status). */
  afterCommand?: (cmd: HomeCommand) => void;
}

export class CommandProcessor {
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<string>();

  constructor(private readonly deps: ProcessorDeps) {}

  /** Feed from the homeCommands(status == approved) listener. Commands run one at a time. */
  onApproved(ids: string[]): void {
    for (const id of ids) {
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.enqueue(() => this.handle(id).finally(() => this.queued.delete(id)));
    }
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Run `fn` exclusively in the command queue (nothing else runs on the Supervisor meanwhile). */
  exclusive(fn: () => Promise<void>): void {
    this.enqueue(fn);
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e) => log.error('Command handling crashed', { error: errMsg(e) }));
  }

  private ctx(settings: HomeSettings): ValidationCtx {
    return { settings, deviceClassOf: this.deps.deviceClassOf, nowMs: this.deps.now(), selfSlug: this.deps.selfSlug() };
  }

  async handle(id: string): Promise<void> {
    const settings = this.deps.settings();
    if (!settings) return; // main only starts the command listener after settings/home loaded
    let cmd: HomeCommand | null = null;
    let refusal: string | null = null;
    const decision: ClaimDecision = await this.deps.store.claim(id, (raw) => {
      cmd = null;
      refusal = null;
      if (!raw || raw.status !== 'approved') return { action: 'skip' };
      const nowIso = iso(this.deps.now());
      const parsed = HomeCommand.safeParse(raw);
      if (!parsed.success) {
        refusal = 'Command does not match the contract.';
      } else {
        const v = validateCommand(parsed.data, this.ctx(settings));
        if (!v.ok && v.status === 'expired') return { action: 'close', fields: { status: 'expired', error: v.error, finishedAt: nowIso } };
        if (!v.ok) refusal = v.error;
        else cmd = parsed.data;
      }
      if (refusal !== null) {
        // Hub rules let the device leave 'approved' only to 'claimed' or 'expired', and claim a
        // sensitive command only when a person approved it. So a refused command is claimed and
        // then failed with the reason, except a sensitive one without approval, which is closed as
        // 'expired' (it must never be claimed).
        const humanApproved = typeof raw.approvedBy === 'string' && HUMAN.test(raw.approvedBy);
        if (raw.sensitive === true && !humanApproved) {
          return { action: 'close', fields: { status: 'expired', error: `Refused by the add-on: ${refusal}`, finishedAt: nowIso } };
        }
      }
      return { action: 'claim', fields: { status: 'claimed', claimedAt: nowIso } };
    });
    if (decision.action === 'close') {
      log.warn('Command not run', { id, status: decision.fields.status, error: decision.fields.error });
      return;
    }
    if (decision.action !== 'claim') return;
    const why = refusal as string | null;
    if (why !== null) {
      log.warn('Command refused', { id, error: why });
      await this.finish(id, { status: 'failed', result: null, error: `Refused by the add-on: ${why}`, backupName: null });
      return;
    }
    const claimed = cmd as HomeCommand | null;
    if (claimed) await this.runClaimed(id, claimed);
  }

  private async runClaimed(id: string, cmd: HomeCommand): Promise<ExecResult> {
    log.info('Running command', { id, kind: cmd.kind, service: cmd.service, entityId: cmd.entityId, target: cmd.target, requestedBy: cmd.requestedBy });
    const res = await this.execute(cmd, id);
    await this.finish(id, res);
    log.info('Command finished', { id, status: res.status, result: res.result, error: res.error });
    this.deps.afterCommand?.(cmd);
    return res;
  }

  async finish(id: string, res: ExecResult): Promise<void> {
    const fields = { status: res.status, result: res.result, error: res.error, backupName: res.backupName, finishedAt: iso(this.deps.now()) };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.deps.store.update(PATHS.homeCommand(id), fields);
        return;
      } catch (e) {
        log.warn('Writing command result failed; retrying', { id, attempt, error: errMsg(e) });
        await this.deps.update.sleep(2000 * 2 ** attempt);
      }
    }
    log.error('Giving up writing command result', { id });
  }

  async execute(cmd: HomeCommand, id: string | null): Promise<ExecResult> {
    const ok = (result: string, backupName: string | null = null): ExecResult => ({ status: 'done', result, error: null, backupName });
    const fail = (error: string, backupName: string | null = null): ExecResult => ({ status: 'failed', result: null, error: error.slice(0, 2000), backupName });
    try {
      switch (cmd.kind) {
        case 'call_service': {
          const [domain, service] = (cmd.service as string).split('.') as [string, string];
          await this.deps.ha.callService(domain, service, serviceData(cmd.data), cmd.entityId as string);
          return ok(`Called ${cmd.service} on ${cmd.entityId}.`);
        }
        case 'backup': {
          const reason = cmd.target ?? (typeof cmd.data.reason === 'string' ? cmd.data.reason : null);
          const name = backupNameFor(this.deps.now(), reason);
          try {
            const b = await createBackup({ sup: this.deps.sup, sleep: this.deps.update.sleep, now: this.deps.now }, { name, kind: 'full' });
            return ok(`Backup '${b.name}' created (${b.slug}).`, b.name);
          } catch (e) {
            return fail(`Backup '${name}' failed: ${errMsg(e)}`, name);
          }
        }
        case 'update':
          return await runUpdate(this.deps.update, cmd.target as string, id);
        case 'restart_addon':
          await this.deps.sup.post(`/addons/${cmd.target as string}/restart`, {}, { timeoutMs: 5 * 60 * 1000 });
          return ok(`Restarted add-on ${cmd.target}.`);
        default:
          return fail('Unknown command kind.');
      }
    } catch (e) {
      return fail(errMsg(e));
    }
  }

  /**
   * Auto-update path: create the command doc ourselves (requestedBy/approvedBy system:addon, already
   * claimed), validate it with the same rules, run it, and complete it like any other command.
   * If the Hub refuses the doc we do NOT run the update (every action must be audited).
   */
  runLocalUpdate(slug: string): Promise<ExecResult | null> {
    return new Promise((resolve) => {
      this.enqueue(async () => {
        const settings = this.deps.settings();
        if (!settings) return resolve(null);
        const nowIso = iso(this.deps.now());
        const cmd: HomeCommand = {
          kind: 'update',
          service: null,
          entityId: null,
          data: {},
          target: slug,
          status: 'claimed',
          requestedBy: ADDON_ACTOR,
          approvedBy: ADDON_ACTOR,
          sensitive: false,
          createdAt: nowIso,
          approvedAt: nowIso,
          claimedAt: nowIso,
          finishedAt: null,
          result: null,
          error: null,
          backupName: null,
        };
        const v = validateCommand(cmd, this.ctx(settings));
        if (!v.ok) {
          log.warn('Auto-update refused by validation', { slug, error: v.error });
          return resolve(null);
        }
        let id: string;
        try {
          id = await this.deps.store.add(PATHS.homeCommands, cmd as unknown as Record<string, unknown>);
        } catch (e) {
          log.warn('Could not record the auto-update command in Home Hub; skipping the update', { slug, error: errMsg(e) });
          return resolve(null);
        }
        try {
          resolve(await this.runClaimed(id, cmd));
        } catch (e) {
          log.error('Auto-update crashed', { slug, error: errMsg(e) });
          resolve(null);
        }
      });
    });
  }
}
