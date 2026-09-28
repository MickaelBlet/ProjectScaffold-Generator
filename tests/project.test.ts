import { describe, expect, it } from 'vitest'
import { belowContent, contentTop, emptyProject, LAYOUT_PAD, modulePath, modulePaths } from '@/model/project'
import type { Module, Project } from '@/model/types'

const mod = (id: string, parentId: string | null, y: number, height: number): Module => ({
  id,
  name: id,
  description: '',
  parentId,
  metadata: {},
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
