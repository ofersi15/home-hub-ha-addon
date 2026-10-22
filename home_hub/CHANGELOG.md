# Changelog

## 0.2.0

- **Auto-update everything you switch on**, including Home Assistant Core, OS and Supervisor
  (`settings.autoUpdate[target]`; `'*'` = all add-ons). Replaces "never auto-update the platform".
- `autoUpdateMode`: `immediate` (as soon as the 5-minute status poll sees an update) or `window`
  (inside the update window, New York time; the default).
- One update at a time, in a fixed order: add-ons, then Supervisor, Core, OS. A global lock in
  `/data/update-state.json` survives restarts and reboots.
- Every update: wait for Supervisor jobs to finish, then backup `hub-pre-update-<target>-<version>-<yyyymmdd-hhmm>`
  (full for Core/OS/Supervisor, just that add-on otherwise). No backup, no update.
- After the update: resume verification after a restart/reboot (20 min for Core/OS, 10 for
  Supervisor, 5 for add-ons); start an add-on once if it does not come back; apply a Supervisor
  `execute_restart` suggestion (and `execute_reboot` only right after an OS update) once.
- A failed update names its backup: "Restore from this backup". 6 h backoff after a failure; 2
  failures in a row stop auto-updates for that target (`blocked` in Pi status) until Retry in Home Hub.
- **Backup retention** (`backupRetention`, default 5): keeps the newest N `hub-` backups, deletes
  older ones after each successful update and once a day. Backups with any other name are never
  touched.
- The Supervisor's own extra pre-update backup is no longer requested (our `hub-` backup is always
  taken, and the Supervisor's copies could never be cleaned up).
- Event rules: numeric `below` (e.g. battery < 20, ignoring unknown/unavailable) and `repeatHours`.
- Contract: `groups`, `confirm`, `pinnedGroups`, `autoUpdateRetry` accepted (Hub UI).
- This add-on still cannot update itself (the Supervisor forbids it); update it from its add-on page.

## 0.1.0

- First release.
- One-time pairing with Home Hub; device key stored in `/data`, signed token exchange, Firebase custom-token sign-in.
- Entity mirror (allowlisted entities, filtered attributes, 5 s coalescing throttle) and entity catalog (every 6 h).
- Heartbeat every 60 s; graceful shutdown marks the hub offline.
- Pi status every 5 min: CPU temperature/load, memory, disk, uptime, updates with release-notes links, add-on states, crash-loop detection, last backup.
- Commands: allowlisted `call_service`, `backup`, `update` (backup first, verify healthy, survives reboot), `restart_addon`. Sensitive commands need a human approval; stale commands expire after 10 minutes.
- Event rules with "for N minutes" timers.
- Opt-in add-on auto-update inside the update window (never Core/OS/Supervisor).
