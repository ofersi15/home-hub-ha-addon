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
- **Event rules**: e.g. "washer power off" or "door open for 10 minutes" -> push or task in Home Hub.
- **Scheduled add-on updates** inside your update window, for the add-ons you opt in. Core, OS and
  Supervisor are never updated automatically.

It never runs shell commands, never uses SSH, never calls the host shutdown/reboot endpoints, and
never uninstalls anything. (An OS update you approve reboots the Pi as part of the update; the
add-on finishes verifying it after the reboot.)

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
- `hassio_api` with role `manager` - the lowest Supervisor role that can list add-ons, create
  backups, update Core/OS/Supervisor/add-ons and restart add-ons. On top of that the add-on has its
  own allowlist of Supervisor paths and refuses everything else.

Pairing data lives only in the add-on's private `/data` folder and is never written to the log.

## Troubleshooting

- **"Not paired yet"**: set `pairing_code` (step 5-6) and start again.
- **"The Hub rejected this device"**: the device was removed in Home Hub; pair again with a new code.
- **"unsupported" warning**: the Supervisor reports the system as unsupported when other containers
  run on the host. The add-on reports it and keeps working.
