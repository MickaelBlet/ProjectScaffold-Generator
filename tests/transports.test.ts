import { describe, expect, it } from 'vitest'
import {
  foreignFields,
  isBuiltinTransport,
  pruneSettings,
  TRANSPORT_FIELDS,
  transportFields
} from '@/model/transports'
import { TRANSPORTS } from '@/model/types'

describe('transports', () => {
  it('lists the fields of every built-in transport', () => {
    expect(Object.keys(TRANSPORT_FIELDS).sort()).toEqual([...TRANSPORTS].sort())
    expect(transportFields('http')).toEqual(['client', 'server', 'path'])
    expect(transportFields('custom')).toEqual([])
    expect(transportFields(undefined)).toEqual([])
  })

  it('tells built-in transports from custom ones', () => {
    expect(isBuiltinTransport('tcp')).toBe(true)
    expect(isBuiltinTransport('zeromq')).toBe(false)
    expect(isBuiltinTransport('')).toBe(false)
    expect(isBuiltinTransport(undefined)).toBe(false)
  })

  it('finds the fields not applying to a transport', () => {
    const s = { server: { port: 1 }, name: 'seg', options: { a: 'b' } }
    expect(foreignFields(s, 'tcp')).toEqual(['name'])
    expect(foreignFields(s, 'shm')).toEqual(['server'])
    expect(foreignFields(s, 'custom')).toEqual(['server', 'name'])
  })

  it('prunes empty values and foreign fields', () => {
    expect(pruneSettings(undefined, 'tcp')).toBeUndefined()
    expect(
      pruneSettings({ client: { host: '', port: 2 }, server: { host: '' }, path: '', name: 'x' }, 'http')
    ).toEqual({ client: { port: 2 } })
    expect(pruneSettings({ options: {} }, 'tcp')).toBeUndefined()
    expect(pruneSettings({ options: { k: '' }, socket: '/s' }, 'custom')).toEqual({ options: { k: '' } })
  })
})
