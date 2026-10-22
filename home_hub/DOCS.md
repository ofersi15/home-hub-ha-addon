# Home Hub add-on

Connects this Home Assistant to **Home Hub** (the household app). Outbound only: the add-on opens
no ports and needs no Nabu Casa, tunnel or port forwarding. It talks to the Supervisor and Home
Assistant inside the Pi, and to Home Hub over HTTPS.

## What it does

- **Mirrors** the entities you pick in Home Hub (Settings -> Home) so they show on the Today screen.
  Only a small, fixed set of attributes leaves the house (units, brightness, temperatures, ...).
- **Runs commands** you approve in Home Hub: call an allowlisted service on an allowlisted entity,
  create a backup, update Core/OS/Supervisor/an add-on (always backup first, then verify HA is healthy),
  or restart one add-on. Locks, alarms, garage doors and the like always need a person's approval:
  the add-on refuses them otherwise, even if Home Hub asked.
- **Reports Pi health**: CPU temperature, disk, memory, uptime, available updates (with release notes
  links), add-on states and crash-loops, last backup.
- **Event rules**: e.g. "washer power off", "door open for 10 minutes" or "blinds battery below 20"
  -> push or task in Home Hub. Numeric rules ignore `unknown`/`unavailable`; `repeatHours` re-sends
  the alert at most once per N hours while the condition lasts (0 = once).
- **Automatic updates with a backup first** for everything you switch on in Home Hub, including
  Home Assistant Core, OS and Supervisor (see below).

It never runs shell commands, never uses SSH, never calls the host shutdown/reboot endpoints, and
never uninstalls anything. (An OS update reboots the Pi as part of the update, through the
Supervisor's own reboot suggestion when needed; the add-on finishes verifying it after the reboot.)

## Automatic updates

Set in Home Hub -> Settings -> Home:

- **Which**: per target (Core, OS, Supervisor, each add-on) or "All add-ons". Core, OS and Supervisor
  are only auto-updated when their own switch is on ("All add-ons" never covers them).
- **When**: *Immediately* (the add-on checks every 5 minutes and starts as soon as it sees an update)
  or *In the update window* (default 03:00-05:00 New York time).

How every update runs:

1. **One at a time.** If several are pending they go in this order: add-ons, then Supervisor, then
   Core, then OS. Nothing starts while the Supervisor is busy (a backup or another job).
2. **Backup first, always**: `hub-pre-update-<target>-<version>-<yyyymmdd-hhmm>`. Full backup for
   Core/OS/Supervisor, a backup of just that add-on otherwise. If the backup fails, the update is not
   attempted and Home Hub shows "Backup failed".
3. **Update.** Core restarts Home Assistant, OS reboots the Pi, Supervisor restarts itself. The add-on
   saves its progress first and picks up where it left off when it starts again.
4. **Verify**: Home Assistant answers, Core is running, the new version is installed, and an add-on
   that was running is running again (it is started once if not). Up to 20 minutes for Core/OS.
   If the Supervisor then asks for a restart (or a reboot right after an OS update), it is done once.
   An OS version that is installed but not booted yet counts as an update too: backup, one reboot,
   verify. The add-on never reboots twice for the same update.
5. **Result** in Home Hub. On failure the message names the backup: *restore from this backup*
   (Settings -> System -> Backups in Home Assistant).

Safety nets: after a failure the same update waits at least 6 hours; after 2 failures in a row
auto-update stops for that target (shown as *blocked*) until you press **Retry** in Home Hub.

The Home Hub add-on cannot update itself (the Supervisor does not allow it). Update it from its page
in Home Assistant (Settings -> Add-ons -> Home Hub -> Update), or switch on that page's own
**Auto update** toggle.

## Backups and retention

The add-on keeps the newest **5** backups it created (names starting `hub-`; change the number in
Home Hub, 2-30) and deletes older ones after each successful update and once a day. Backups with
any other name (yours, Home Assistant's automatic ones) are never deleted. A backup named in a
failed update is kept until that failure is cleared.

If you still have a Home Assistant automation that forces updates at night, turn it off: the two
would race each other.

## Install

1. In Home Assistant open **Settings -> Add-ons -> Add-on store**.
2. Open the **⋮** menu (top right) -> **Repositories**.
3. Add `https://github.com/ofersi15/home-hub-ha-addon` and close the dialog.
4. Find **Home Hub** in the store (refresh the page if needed) and click **Install**.
5. In Home Hub open **Settings -> Home -> Pair** and copy the one-time pairing code.
6. In the add-on's **Configuration** tab paste it into `pairing_code` and click **Save**.
7. Go to the **Info** tab, keep **Start on boot** on, and click **Start**.
8. Open the **Log** tab: you should see `Paired with Home Hub` and `Signed in to Home Hub`.
   Home Hub shows the Pi as online within a minute.

After pairing you can clear `pairing_code` (the code is single use, so leaving it is harmless).
To pair again (for example after removing the device in Home Hub), put a NEW code in
`pairing_code` and restart the add-on.

## Options

| Option         | Default                       | Meaning                                              |
| -------------- | ----------------------------- | ---------------------------------------------------- |
| `hub_url`      | `https://oferel-hub.web.app`  | Home Hub base URL (must be HTTPS).                   |
| `pairing_code` | empty                         | One-time code from Home Hub Settings -> Home -> Pair. |

## Permissions it asks for, and why

- `homeassistant_api` - read states, subscribe to state changes, call allowlisted services.
- `hassio_api` with role `manager` - the lowest Supervisor role that can list add-ons, create and
  delete backups, update Core/OS/Supervisor/add-ons, start/restart add-ons and apply Supervisor
  repair suggestions. On top of that the add-on has its own allowlist of exact Supervisor paths and
  refuses everything else (only backups named `hub-...` are ever deleted).

Pairing data lives only in the add-on's private `/data` folder and is never written to the log.

## Troubleshooting

- **"Not paired yet"**: set `pairing_code` (step 5-6) and start again.
- **"The Hub rejected this device"**: the device was removed in Home Hub; pair again with a new code.
- **"unsupported" warning**: the Supervisor reports the system as unsupported when other containers
  run on the host. The add-on reports it and keeps working.
