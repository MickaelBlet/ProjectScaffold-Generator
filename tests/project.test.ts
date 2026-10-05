import { describe, expect, it } from 'vitest'
import {
  ATTR_ROW,
  belowContent,
  contentTop,
  emptyProject,
  findView,
  indexById,
  isolatedModuleId,
  isolatedViewId,
  LAYOUT_PAD,
  minSize,
  modulePath,
  modulePaths,
  parentIds,
  viewExists
} from '@/model/project'
import { GLOBAL_VIEW, type Module, type Project } from '@/model/types'

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

describe('indexes', () => {
  it('are built once per array', () => {
    const modules = [mod('a', null, 0, 10), mod('b', 'a', 0, 10)]
    expect(indexById(modules).get('b')).toBe(modules[1])
    expect(indexById(modules)).toBe(indexById(modules))
    expect([...parentIds(modules)]).toEqual(['a'])
    const next = [...modules, mod('c', 'b', 0, 10)]
    expect(indexById(next).get('c')).toBe(next[2])
    expect([...parentIds(next)].sort()).toEqual(['a', 'b'])
  })
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

describe('temporary views', () => {
  const p: Project = {
    ...emptyProject(),
    modules: [mod('root', null, 0, 400), mod('a', 'root', 60, 50)],
    views: [{ id: 'v', name: 'Stored', rootModuleId: 'a', hidden: [] }]
  }

  it('show a module, named after it', () => {
    const id = isolatedViewId('a')
    expect(isolatedModuleId(id)).toBe('a')
    expect(findView(p, id)).toMatchObject({ id, name: 'a', rootModuleId: 'a', hidden: [], temporary: true })
    expect(viewExists(p, id)).toBe(true)
  })

  it('keep the same hidden list between lookups', () => {
    const id = isolatedViewId('a')
    expect(findView(p, id).hidden).toBe(findView(p, id).hidden)
  })

  it('do not exist once the module is gone', () => {
    const id = isolatedViewId('gone')
    expect(findView(p, id).id).toBe(GLOBAL_VIEW)
    expect(viewExists(p, id)).toBe(false)
  })

  it('are not stored views', () => {
    expect(isolatedModuleId('v')).toBeNull()
    expect(findView(p, 'v').temporary).toBeUndefined()
    expect(viewExists(p, 'v') && viewExists(p, GLOBAL_VIEW)).toBe(true)
    expect(viewExists(p, 'unknown')).toBe(false)
  })
})
