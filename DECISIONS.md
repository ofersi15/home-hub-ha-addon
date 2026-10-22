# Decisions

Short log of choices made in the Home Hub add-on and why. Newest at the bottom.

## D1 - Node 22 + TypeScript, Firebase JS SDK, `ws`

The Hub is TypeScript end to end, so the add-on is too. It signs in with a Firebase custom token
(JS SDK v13, modular) to get realtime Firestore listeners under the Hub's security rules, which give
the device identity only the access it needs. `ws` for the HA WebSocket API. Compiled with `tsc`
in a build stage; the runtime image holds Node + compiled JS + production deps only.

## D2 - `hassio_role: manager` (the minimum that works)

Supervisor roles for add-ons (developer docs, "Add-on security" / API role; enforced by the
Supervisor's `api/security.py`):

| Role            | Grants (besides `/<x>/info` and the always-allowed `/info`, `/addons/self/...`) |
| --------------- | ------------------------------------------------------------------------------- |
| `default`       | Only the `*/info` endpoints.                                                    |
| `homeassistant` | + `/core/*` (`/homeassistant/*`).                                               |
| `backup`        | + `/backups*`.                                                                  |
| `manager`       | + `/addons/<slug>/*`, `/store*`, `/backups*`, `/core/*`, `/os/*`, `/supervisor/*`, `/host/*`, `/jobs/*`, ... (everything except security-sensitive admin APIs). |
| `admin`         | Everything (incl. add-on security settings, docker/full access).               |

What the add-on needs:

- read: `/info`, `/host/info`, `/os/info`, `/core/info`, `/supervisor/info`, `/addons/<slug>/info`
  (all `default`); the **add-on list `/addons`** and **`/backups`** (not `default`);
- create backups: `/backups/new/*` (`backup` would do);
- update Core: `/core/update` (`homeassistant` would do);
- update OS and Supervisor: `/os/update`, `/supervisor/update`; update add-ons:
  `/store/addons/<slug>/update`; restart add-ons: `/addons/<slug>/restart`, and job status `/jobs/*`.
  These exist **only from `manager` up**.

No lower role (and no combination: an add-on has exactly one role) covers OS/Supervisor/add-on
updates and add-on restarts, so `manager` is the minimum; `admin` is not needed. `manager` is broader
than we need (it would allow e.g. host power actions), so the add-on adds its own **path allowlist**
in `src/supervisor.ts`: exactly the GET/POST paths above, everything else is refused before a
request is made, and `tests/noShell.test.ts` fails the build if the source mentions host shutdown,
host reboot or add-on uninstall, or any process/shell API.

## D3 - Pairing and auth

Single-use pairing code -> `{deviceId, deviceKey}` in `/data/device.json` (mode 0600, never logged).
`sha256(code)` is stored too, so leaving the used code in the options is harmless while a NEW code
re-pairs (a rejected new code keeps the existing pairing). Token exchange is signed with the Hub's
existing HMAC scheme (`${ts}.POST./api/home/token.` with an empty body). The Firebase SDK refreshes
ID tokens itself; on `permission-denied`/`unauthenticated` we re-exchange (single flight, at most
every 30 s, retries with backoff forever: a Hub outage never kills the add-on).

`haInstance` sent at pairing: the Supervisor does not expose HA's instance UUID, and the Hub contract
defines it as free text naming the install, so we send HA's `location_name` (from `/core/api/config`),
falling back to the hostname, then `/info.machine_id`. It is a label, not a secret or an identity.

## D4 - Defense in depth on commands

The Hub decides what is `approved`; the add-on re-checks independently in the claim transaction:
expired after 10 min (from the later of createdAt/approvedAt), service AND entity allowlists,
sensitive (contract `isSensitive`, plus `cover.*` with an unknown device class, plus sensitive
service domains like `lock.*`) requires `approvedBy` = `user:ofer|user:arielle` (an agent/system
approval does not count), Core/OS/Supervisor updates require `approvedBy: user:ofer` (CLAUDE.md:
"always need Ofer's approval"). `entity_id/area_id/device_id/floor_id/label_id` are stripped from
service data so a command can't retarget itself. The add-on never restarts itself.

Status transitions follow the Hub's Firestore rules (`deviceTransition`): the device may only move
`approved -> claimed -> done|failed` or `approved -> expired`. So a refused command is claimed and
then `failed` with `error: "Refused by the add-on: <reason>"`; a command flagged `sensitive` without a
human approval is never claimed (the rules forbid it) and is closed as `expired` with the reason.

## D5 - Updates: our backup first, plus the Supervisor's built-in one where offered

Every update starts with our named backup `hub-pre-update-<target>-<version>` (full for
Core/OS/Supervisor; partial with just that add-on for add-ons). No backup -> no update. Core and
add-on updates also pass `backup: true` to the Supervisor (`USE_BUILTIN_UPDATE_BACKUP`), as asked;
that costs an extra partial backup's disk space and is a one-line flip if the SD card gets tight.
Backups run with `background: true` and are followed via `/jobs/<id>` (fallback: find by name in
`/backups`), so long backups don't hit HTTP timeouts.

Verify: HA `/api/` answers, `/api/config` state `RUNNING`, Supervisor `/info` state `running`, the
target reports the new version, and an add-on that was started before is started again. Budget 15
min for Core/OS, 10 for Supervisor, 5 for add-ons. OS/Supervisor/self updates can kill the process,
so the in-flight update is persisted to `/data/inflight.json` before the update call and verified
on the next start; a dropped connection during the update call is not treated as a failure.

## D6 - Auto-update is audited before it runs (0.1.0; superseded in part by D9-D12)

Auto-updates create a `homeCommands` doc (`requestedBy`/`approvedBy` `system:addon`, status
`claimed`) and go through the same validation and executor as Hub commands. If the Hub's rules refuse
that doc, the update is skipped: nothing runs without an audit record. (As of 0.1.0 the Hub rules
only let the household create commands, so the Hub must add a narrow device `create` rule for
these: kind `update`, requestedBy/approvedBy `system:addon`, status `claimed`, target not
core/os/supervisor, sensitive false.) Each `slug@version` is
attempted once (persisted in `/data/autoupdate.json`), so a failing update doesn't loop. One add-on
per 5-minute cycle. The add-on never auto-updates itself, Core, OS or Supervisor.

## D7 - Pi metrics

Host-wide CPU %, memory % and uptime come from `/proc` via `node:os` (not namespaced inside the
container); disk from `/host/info`; uptime prefers `/host/info.boot_timestamp`. CPU temperature from
`/sys/class/thermal/thermal_zone0/temp` (read-only sysfs), falling back to an HA System Monitor sensor
if mirrored in the state cache. Per-add-on `/stats` is not read: the contract has no field for it.
`AddonInfo.boot` comes from `/addons/<slug>/info`; `PiStatus.supervisor` (supported/healthy + reasons)
from `/supervisor/info` and `/resolution/info`. `supported: false` (other containers on the host) is
reported there and logged as a warning, never treated as an error.
Crash-loops: add-on states are sampled every 60 s (cheap `/addons`) and every return to `started`
counts as a restart (`recentRestarts` = last hour).

## D8 - Process model

`init: false`, no s6 services: Node is PID 1 (`ENTRYPOINT []`), handles SIGTERM by flushing pending
entity writes and writing `home/state.online = false`. Exit code is non-zero only for fatal config
errors (bad options, missing Supervisor token, not paired / pairing code rejected).

## D9 - 0.2.0: auto-update everything Ofer switches on, including Core/OS/Supervisor

Ofer (2026-10-22): "I do want everything to auto update (with backup) and restart when needed on a
daily basis (if possible to install updates immediately when available)". His HA automation ("force
all updates and restart at 1 AM") missed updates; this replaces it. So the 0.1.0 rule "never
auto-update the platform" is gone, but platform targets stay **opt-in per target**:
`autoUpdate.core|os|supervisor === true`; `'*'` covers add-ons only, and an explicit `false` for a
slug beats `'*'` (same helper as the Hub, `autoUpdateEnabled`, and the same logic as the Hub's
`deviceAutoUpdateRecord` rule). A Hub-created platform command still needs `approvedBy: user:ofer`;
only the add-on's own auto path (validated with `auto: true`, actor `system:addon`, against the live
settings snapshot right before the audit doc is created) uses the policy, so a command doc claiming
`system:addon` approval that arrives through the Hub listener is refused. The audit doc comes first,
as before (D6); if the Hub refuses it, nothing runs and that target is left alone for an hour.

Modes: `immediate` = the 5-minute Pi poll starts the next eligible update; `window` = same flow,
only inside `autoUpdateWindow` (NY). After each update the poll re-runs within seconds, so a backlog
drains one by one.

**Order** when several are pending, one at a time:
1. **Add-ons first**: smallest blast radius, partial backups are quick, and an add-on update never
   takes HA down, so most of the backlog clears before anything risky.
2. **Supervisor** next: newer Core/OS releases can require a newer Supervisor, and the Supervisor
   performs the Core and OS updates, so it should be current first.
3. **Core** before OS: a Core restart is short and verifiable without a reboot; doing it first means
   one reboot (the OS update) at the very end instead of a reboot followed by more restarts.
4. **OS last**: it reboots the host, the most disruptive step with the longest verify (20 min).
5. **This add-on** would go last (it would restart the engine itself), but the Supervisor rejects
   `POST /store/addons/<self>/update` from the add-on itself (`APIForbidden: can't update itself`,
   supervisor/api/store.py). So self is never picked and a self-update command is refused with that
   reason. Ofer updates Home Hub from its add-on page, or turns on that page's own "Auto update".

The Supervisor's own extra pre-update backup (`backup: true`, D5) is now **off**: our `hub-` backup is
always taken first, and the Supervisor's copies are not `hub-` backups, so retention (D12) could
never delete them and daily auto-updates would fill the SD card.

## D10 - The update engine: lock, phases, verify, restart suggestions

- **Lock** = `/data/update-state.json` `{target, fromVersion, toVersion, backupName, phase, startedAt,
  commandId, requireStarted, auto}`, `phase` in `backup | updating | verifying`. While it exists no
  other update starts (a Hub command fails with "Another update is in progress" without touching the
  Supervisor). The command queue also serializes everything in-process. 0.1.0's `inflight.json` is
  migrated on first start.
- **Supervisor busy**: `GET /jobs/info`; any top-level job with `done: false` (finished jobs stay in
  the list) means wait. Auto: skip this poll. Hub command: wait up to 10 min, then fail.
- **Backup** `hub-pre-update-<target>-<toVersion>-<yyyymmdd-hhmm>` (NY time; the timestamp keeps a
  retry of the same version from colliding). Failure -> "Backup failed: ... NOT attempted".
- The phase is written **before** the step that can kill us. On start: `backup` -> the update never
  ran; fail it as not attempted (no update without a confirmed backup). `updating`/`verifying` ->
  verify (a version that never changed fails with the backup name, so a lost update call is safe).
- **Verify**: HA `/api/` answers, `/api/config` RUNNING, Supervisor running, `/core/info` running,
  the target reports `toVersion` or newer (numeric compare), and an add-on that was started before is
  started. Budgets from the start of verification (also after a reboot): Core/OS 20 min, Supervisor
  10, add-ons 5. An add-on that comes back stopped/error is started once (`POST /addons/<slug>/start`);
  one that was stopped on purpose before the update is left stopped.
- **Completion order**: outcome to the command doc first, then clear the lock, then follow-ups. A crash
  in between re-verifies (idempotent) instead of leaving a command stuck in `claimed`.
- **Restart when needed**: Core/OS/Supervisor updates restart on their own. `/core/info` has no
  "restart pending" flag; the Supervisor signals it through `/resolution/info` suggestions
  (`{uuid, type, context, reference}`, uuid4 hex; issue `reboot_required` -> suggestion
  `execute_reboot`). Right after OUR verified update we apply, once each: `execute_restart` (any
  context), and `execute_reboot` **only after an OS update**. Other suggestions are only reported in
  the command result. `POST /resolution/suggestion/<32 hex>` is the only resolution write allowed.
  Why this reboot path is acceptable while `/host/reboot` stays forbidden: it is the Supervisor's own
  repair action for a reboot it already asked for; it runs only immediately after an OS update that
  itself just rebooted the host (the risk Ofer opted into); the lock is already cleared and the
  outcome recorded; and the add-on still cannot reboot the host on its own initiative or on any
  Hub/agent command. `tests/noShell.test.ts` keeps `/host/reboot`, `/host/shutdown` and uninstall out
  of the source and the allowlist.

## D11 - Failures: 6 h backoff, 2 strikes, Retry

Auto-update failures per target live in `/data/autoupdate.json` (the 0.1.0 "attempted slug@version"
list is discarded). After a failure the same target waits >= 6 h; after 2 consecutive failures it is
**blocked** (`PiStatus.updates[].blocked = true`), whatever the version, until a household member
presses Retry (`settings.autoUpdateRetry[target]` newer than the last failure; settings stay
read-only for the add-on, so a timestamp is the signal) or switches that target's auto-update off.
Any successful update of the target (auto or manual) resets it. Lock/busy refusals are transient and
do not count. Manual (Hub) failures do not count: a person is already looking.

## D12 - Backup retention: only `hub-` backups, double-checked

The newest `backupRetention` (default 5, min 2) backups whose name starts with `hub-` are kept; older
ones are deleted after each successful update and once a day (the first run is right after 0.2.0
starts). A backup is deleted only if its slug is 8 hex chars and its name starts with `hub-` both in
the list AND in `GET /backups/<slug>/info` right before `DELETE /backups/<slug>`. Never deleted:
anything not named `hub-...`, the backup of the update in flight, and backups named in an open
failure (D11). `DELETE /backups/<8 hex>` is the only DELETE in the allowlist.

## D13 - Event rules: numeric `below` and `repeatHours`

A rule fires per **episode** (a continuous stretch where the condition holds). Numeric rules parse
the state as a float; `unknown`/`unavailable`/non-numbers are ignored entirely (they neither start
nor end an episode), so a flaky battery sensor does not re-alert. `forMinutes` applies to both kinds.
`repeatHours > 0` re-fires every `repeatHours` while the episode lasts; repeats are exactly that far
apart, so each lands in its own UTC bucket of `repeatHours`, which is how the Hub dedupes them. A
rule that appears mid-episode (new rule, or a restart: `seed`) is adopted as already fired, so a
restart never double-alerts; its next repeat comes a full period later.
