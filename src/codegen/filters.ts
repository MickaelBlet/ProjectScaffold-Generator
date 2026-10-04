// Language-neutral Liquid filters: identifier case conversions, name-based UUIDs.
import { hash } from './sections'

/** Words of an identifier: `rateHz` → rate, Hz; `HTTPServer` → HTTP, Server; `snake_case` → snake, case. */
export function words(s: string): string[] {
  return (
    String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .match(/[A-Za-z0-9]+/g) ?? []
  )
}

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()

export const snake = (s: string): string =>
  words(s)
    .map((w) => w.toLowerCase())
    .join('_')

export const kebab = (s: string): string =>
  words(s)
    .map((w) => w.toLowerCase())
    .join('-')

export const constant = (s: string): string =>
  words(s)
    .map((w) => w.toUpperCase())
    .join('_')

export const pascal = (s: string): string => words(s).map(cap).join('')

export function camel(s: string): string {
  const p = pascal(s)
  return p.charAt(0).toLowerCase() + p.slice(1)
}

/** First letter upper case, the rest unchanged (`rateHz` → `RateHz`). */
export const ucfirst = (s: string): string => String(s).charAt(0).toUpperCase() + String(s).slice(1)

/** First letter lower case, the rest unchanged (`Sensor` → `sensor`). */
export const lcfirst = (s: string): string => String(s).charAt(0).toLowerCase() + String(s).slice(1)

/**
 * UUID made from a text (`8d7e…`): the same text always gives the same UUID, e.g. stable ids of
 * descriptors across generations. Version 8 (custom), not a cryptographic hash.
 */
export function uuid(s: string): string {
  const h = [0, 1, 2].map((i) => hash(`${i}:${s}`)).join('')
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const caseFilters: Record<string, (s: string) => string> = {
  snake,
  kebab,
  constant,
  pascal,
  camel,
  ucfirst,
  lcfirst
}
