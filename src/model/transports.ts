// Settings of the built-in transports: which fields apply to each, defaults, pruning.
import { TRANSPORTS, type Transport, type TransportSettings } from './types'

export type TransportField = Exclude<keyof TransportSettings, 'options'>

/** Fields of the settings of each built-in transport (custom transports: `options` only). */
export const TRANSPORT_FIELDS: Record<Transport, readonly TransportField[]> = {
  ipc: ['socket'],
  shm: ['name', 'capacity'],
  tcp: ['client', 'server'],
  udp: ['client', 'server'],
  http: ['client', 'server', 'path'],
  grpc: ['client', 'server'],
  websocket: ['client', 'server', 'path'],
  mqtt: ['broker', 'topic'],
  can: ['interface', 'id'],
  serial: ['device', 'baud']
}

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_BASE_PORT = 47000
export const DEFAULT_SHM_CAPACITY = 1 << 20

export function isBuiltinTransport(t: string | undefined): t is Transport {
  return (TRANSPORTS as readonly string[]).includes(t ?? '')
}

/** Fields of the settings of transport `t`: none for a custom or unset one. */
export function transportFields(t: string | undefined): readonly TransportField[] {
  return isBuiltinTransport(t) ? TRANSPORT_FIELDS[t] : []
}

/** Fields set in `s` that do not apply to transport `t`. */
export function foreignFields(s: TransportSettings, t: string | undefined): TransportField[] {
  const fields = transportFields(t)
  return (Object.keys(s) as (keyof TransportSettings)[]).filter(
    (k): k is TransportField => k !== 'options' && !fields.includes(k)
  )
}

/** `s` without empty values (options kept as typed) and fields not applying to transport `t`; undefined when nothing is left. */
export function pruneSettings(
  s: TransportSettings | undefined,
  t: string | undefined
): TransportSettings | undefined {
  if (!s) return undefined
  const fields = transportFields(t)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (k !== 'options' && !fields.includes(k as TransportField)) continue
    if (v === undefined || v === '') continue
    if (k === 'options') {
      if (Object.keys(v as object).length) out[k] = v
    } else if (typeof v === 'object') {
      const inner = Object.fromEntries(
        Object.entries(v as object).filter(([, x]) => x !== undefined && x !== '')
      )
      if (Object.keys(inner).length) out[k] = inner
    } else out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}
