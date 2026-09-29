import { describe, expect, it } from 'vitest'
import {
  ATTR_ROW,
  belowContent,
  contentTop,
  emptyProject,
  LAYOUT_PAD,
  minSize,
  modulePath,
  modulePaths
} from '@/model/project'
import type { Module, Project } from '@/model/types'

const mod = (id: string, parentId: string | null, y: number, height: number): Module => ({
  id,
  name: id,
  description: '',
  parentId,
  metadata: {},
  attributes: [],
  methods: [],
  ports: [],
  layout: { x: 0, y, width: 100, height }
})

describe('belowContent', () => {
  const p: Project = {
    ...emptyProject(),
    modules: [mod('parent', null, 0, 400), mod('a', 'parent', 60, 50), mod('b', 'parent', 150, 80)]
  }

  it('is below the lowest submodule', () => {
    expect(belowContent(p, 'parent')).toBe(150 + 80 + LAYOUT_PAD)
  })

  it('leaves out the given module', () => {
    expect(belowContent(p, 'parent', 'b')).toBe(60 + 50 + LAYOUT_PAD)
  })

  it('starts below the header of an empty module', () => {
    expect(belowContent(p, 'a')).toBe(contentTop(p.orientation) + LAYOUT_PAD)
  })
})

describe('modulePaths', () => {
  it('matches modulePath for every module', () => {
    const p: Project = {
      ...emptyProject(),
      modules: [mod('root', null, 0, 400), mod('a', 'root', 60, 50), mod('b', 'a', 60, 50)]
    }
    const paths = modulePaths(p)
    for (const m of p.modules) expect(paths.get(m.id)).toBe(modulePath(p, m.id))
    expect(paths.get('b')).toBe('root.a.b')
  })
})

describe('attributes', () => {
  const attr = (name: string) => ({
    id: name,
    name,
    type: { kind: 'primitive', name: 'bool' } as const,
    description: ''
  })

  it('grow the smallest size of a module', () => {
    const m = { ...mod('m', null, 0, 100), attributes: [attr('a'), attr('b')] }
    for (const o of ['horizontal', 'vertical'] as const)
      expect(minSize(m, o).height - minSize({ ...m, attributes: [] }, o).height).toBe(2 * ATTR_ROW + 8)
  })

  it('grow the smallest size of a module with methods too', () => {
    const method = { id: 'f', name: 'f', description: '', params: [], returns: null }
    const m = { ...mod('m', null, 0, 100), attributes: [attr('a')], methods: [method] }
    for (const o of ['horizontal', 'vertical'] as const)
      expect(minSize(m, o).height - minSize({ ...m, attributes: [], methods: [] }, o).height).toBe(
        2 * (ATTR_ROW + 8)
      )
  })

  it('push the content of a container down', () => {
    const parent = { ...mod('parent', null, 0, 400), attributes: [attr('a')] }
    const p: Project = { ...emptyProject(), modules: [parent] }
    expect(belowContent(p, 'parent')).toBe(contentTop(p.orientation) + ATTR_ROW + 8 + LAYOUT_PAD)
  })
})
