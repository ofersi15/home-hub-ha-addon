# Changelog

## 0.1.0

- First release.
- One-time pairing with Home Hub; device key stored in `/data`, signed token exchange, Firebase custom-token sign-in.
- Entity mirror (allowlisted entities, filtered attributes, 5 s coalescing throttle) and entity catalog (every 6 h).
- Heartbeat every 60 s; graceful shutdown marks the hub offline.
- Pi status every 5 min: CPU temperature/load, memory, disk, uptime, updates with release-notes links, add-on states, crash-loop detection, last backup.
- Commands: allowlisted `call_service`, `backup`, `update` (backup first, verify healthy, survives reboot), `restart_addon`. Sensitive commands need a human approval; stale commands expire after 10 minutes.
- Event rules with "for N minutes" timers.
- Opt-in add-on auto-update inside the update window (never Core/OS/Supervisor).
