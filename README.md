# Home Hub add-ons for Home Assistant

Home Assistant add-on repository for **Home Hub**, a private household app. The add-on connects a
Home Assistant OS install (Raspberry Pi 4, aarch64; amd64 also built) to Home Hub:

- mirrors allowlisted entities and a catalog of all entities,
- runs approved, allowlisted commands (service calls, backups, updates, add-on restarts),
- reports Pi health, available updates and add-on states,
- evaluates simple event rules ("door open 10 min", "washer done").

**Outbound only.** No ports, no host network, not privileged, no Nabu Casa or tunnel. It talks to the
Supervisor API and Home Assistant inside the box and to Home Hub over HTTPS. It never runs shell
commands or SSH.

This repository is public and contains no secrets: pairing creates a per-device key at runtime,
stored only in the add-on's private `/data` volume.

## Install

Add-on store -> ⋮ -> Repositories -> add `https://github.com/ofersi15/home-hub-ha-addon` ->
install **Home Hub** -> set `pairing_code` from Home Hub Settings -> Home -> Pair -> Start.
Full steps: [home_hub/DOCS.md](home_hub/DOCS.md).

## Layout

```
repository.yaml          add-on repository metadata
home_hub/                the add-on
  config.yaml            add-on manifest (slug home_hub, hassio_role manager)
  build.yaml             base images per arch
  Dockerfile             multi-stage: compile TypeScript, run on Node 22
  src/                   TypeScript source (contract.ts mirrors Home Hub shared/schemas/home.ts)
  tests/                 Vitest (Supervisor / HA / Firestore mocked)
DECISIONS.md             why things are the way they are (role choice etc.)
```

## Develop

```sh
cd home_hub
npm install
npm run typecheck
npm test
npm run build
```

The data contract lives in Home Hub (`shared/schemas/home.ts`); `home_hub/src/contract.ts` is a typed
copy. Change both together.

## License

MIT
