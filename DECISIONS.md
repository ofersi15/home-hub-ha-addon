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

## D6 - Auto-update is audited before it runs

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
