/**
 * Only a small allowlisted subset of HA attributes leaves the house. Everything else (entity_picture
 * URLs with tokens, access tokens of cameras/media players, GPS coordinates, IPs, ...) is dropped.
 */
export const ATTRIBUTE_ALLOWLIST = [
  'unit_of_measurement',
  'device_class',
  'state_class',
  'icon',
  'brightness',
  'color_mode',
  'color_temp_kelvin',
  'temperature',
  'current_temperature',
  'target_temp_low',
  'target_temp_high',
  'hvac_action',
  'hvac_modes',
  'preset_mode',
  'fan_mode',
  'humidity',
  'current_humidity',
  'battery_level',
  'current_position',
  'percentage',
  'is_volume_muted',
  'volume_level',
  'media_title',
  'media_artist',
  'source',
] as const;

const ALLOW = new Set<string>(ATTRIBUTE_ALLOWLIST);
const MAX_STRING = 200;

function cleanValue(v: unknown): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.slice(0, MAX_STRING);
  if (Array.isArray(v)) {
    const items = v.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, 20);
    return items.map((x) => (typeof x === 'string' ? x.slice(0, MAX_STRING) : x));
  }
  return undefined; // nested objects never leave
}

export function filterAttributes(attrs: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (!ALLOW.has(k)) continue;
    const c = cleanValue(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}
