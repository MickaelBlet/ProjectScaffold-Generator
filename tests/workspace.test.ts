import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadText, parseText } from '@/model/serialize'
import { resolveRelative } from '@/model/sync'
import { FileWorkspaceSchema, isWorkspaceData, workspaceFromFile, workspaceText } from '@/model/workspace'

const EXAMPLE = 'examples/fleet/fleet.scaffold-workspace.yaml'
const example = parseText(readFileSync(EXAMPLE, 'utf8'), 'yaml')

describe('workspace files', () => {
  it('tells workspaces from projects', () => {
    expect(isWorkspaceData(example)).toBe(true)
    expect(isWorkspaceData(parseText(readFileSync('examples/robot.scaffold.yaml', 'utf8'), 'yaml'))).toBe(
      false
    )
    expect(isWorkspaceData(null)).toBe(false)
    expect(isWorkspaceData('workspace')).toBe(false)
  })

  it('lists project files that load, relative to the workspace file', () => {
    const ws = workspaceFromFile(example)
    expect(ws.name).toBe('Fleet')
    expect(ws.projects).toHaveLength(5)
    for (const file of ws.projects)
      expect(loadText(readFileSync(resolveRelative(EXAMPLE, file), 'utf8'), 'yaml').name).toBeTruthy()
  })

  it('normalizes paths and drops duplicates', () => {
    const ws = workspaceFromFile({
      schemaVersion: 1,
      workspace: { name: 'W' },
      projects: ['./a.scaffold.yaml', 'sub/../a.scaffold.yaml', 'sub\\b.scaffold.yaml']
    })
    expect(ws.projects).toEqual(['a.scaffold.yaml', 'sub/b.scaffold.yaml'])
  })

  it('reports schema errors', () => {
    expect(() => workspaceFromFile({ schemaVersion: 1, workspace: {}, projects: [''] })).toThrow(
      /workspace\.name[\s\S]*projects\.0/
    )
  })

  it('round-trips through its text', () => {
    const ws = workspaceFromFile(example)
    expect(workspaceFromFile(parseText(workspaceText(ws), 'yaml'))).toEqual(ws)
  })

  it('schema/scaffold-workspace.schema.json is up to date (run `npm run schema`)', () => {
    const json: unknown = JSON.parse(readFileSync('schema/scaffold-workspace.schema.json', 'utf8'))
    expect(z.toJSONSchema(FileWorkspaceSchema, { target: 'draft-2020-12', io: 'input' })).toEqual(json)
  })
})
