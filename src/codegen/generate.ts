// Renders a template set over a project: the files to generate, with the default content of their
// user sections. Pure: merging with the files on disk is done by run.ts.
import { Liquid } from 'liquidjs'
import { buildContext, type GenContext } from './context'
import { caseFilters, uuid } from './filters'
import { placeMarkers, UserTag } from './sections'
import { isInsidePath, type TemplateSet } from './templateSet'
import type { FileProject } from '../model/schema'

export interface GeneratedFile {
  /** Relative to the output directory, `/`-separated. */
  path: string
  text: string
  /** Line comment of the user section markers. */
  comment: string
}

export interface Generation {
  files: GeneratedFile[]
  warnings: string[]
}

export class GenerationError extends Error {}

/** Checks and normalizes a generated file path: relative, inside the output directory. */
export function outputPath(path: string): string {
  if (!isInsidePath(path))
    throw new GenerationError(`invalid output path '${path}': must be relative, use '/' and stay inside`)
  return path
    .trim()
    .replace(/\/+/g, '/')
    .split('/')
    .filter((s) => s !== '.')
    .join('/')
}

/** A line holding only one tag, `user` / `enduser` excepted (their lines place the markers). */
const TAG_LINE = /^[ \t]*(\{%-?(?![ \t]*(?:user|enduser)\b)(?:(?!%\})[^\n])*%\})[ \t]*\r?\n/gm

/** Like Jinja's trim_blocks + lstrip_blocks: tags on lines of their own leave nothing. */
export const trimTagLines = (template: string): string => template.replace(TAG_LINE, '$1')

// Written by filters whose output is empty, e.g. no description: the line holding it is dropped.
const DROP = '\uE002'
const dropLines = (text: string): string =>
  text.replace(new RegExp(`^[ \\t]*${DROP}[ \\t]*\\r?\\n`, 'gm'), '').replaceAll(DROP, '')

/**
 * Liquid engine of a template set. Templates get the generation context as globals (partials too),
 * and only language-neutral additions: the `user` tag and the case / comment filters.
 */
export function createEngine(templates: Record<string, string>, globals: object): Liquid {
  const liquid = new Liquid({
    templates,
    // `render '_type'` finds `_type.liquid`.
    extname: '.liquid',
    globals,
    strictVariables: true,
    strictFilters: true,
    lenientIf: true,
    greedy: false
  })
  liquid.registerTag('user', UserTag)
  const filters: Record<string, (s: string, ...args: string[]) => string> = {
    ...caseFilters,
    uuid,
    doc_comment: docComment
  }
  for (const [name, f] of Object.entries(filters))
    liquid.registerFilter(name, (s: unknown, ...args: unknown[]) => f(text(s), ...args.map(text)))
  return liquid
}

/** A filter input as text: objects as JSON rather than `[object Object]`. */
function text(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return v === null || v === undefined ? '' : (JSON.stringify(v) ?? '')
}

/** Names of the project that are reserved words of the target language. */
export function reservedNames(ctx: GenContext, reserved: string[]): string[] {
  const words = new Set(reserved)
  const warnings: string[] = []
  const check = (n: string, where: string): void => {
    if (words.has(n)) warnings.push(`${where}: '${n}' is a reserved word, renamed in the generated code`)
  }
  for (const t of ctx.types) {
    check(t.name, t.name)
    if (t.kind === 'struct' || t.kind === 'exception')
      for (const f of t.fields) check(f.name, `${t.name}.${f.name}`)
    if (t.kind === 'enum') for (const v of t.values) check(v.name, `${t.name}.${v.name}`)
    if (t.kind === 'bitmask') for (const v of t.flags) check(v.name, `${t.name}.${v.name}`)
  }
  for (const c of ctx.constants) check(c.name, c.name)
  for (const i of ctx.interfaces) {
    check(i.name, i.name)
    for (const m of i.messages) {
      check(m.name, `${i.name}.${m.name}`)
      for (const p of m.params) check(p.name, `${i.name}.${m.name}(${p.name})`)
    }
  }
  for (const m of ctx.modules) {
    check(m.name, m.path)
    for (const a of m.attributes) check(a.name, `${m.path}.${a.name}`)
    for (const x of m.methods) {
      check(x.name, `${m.path}.${x.name}`)
      for (const p of x.params) check(p.name, `${m.path}.${x.name}(${p.name})`)
    }
    for (const p of m.ports) check(p.name, `${m.path}:${p.name}`)
  }
  return warnings
}

/** Each line of a description after `prefix` (e.g. `  /// `); no line for no description. */
function docComment(text: string, prefix: string = '/// '): string {
  if (!text) return DROP
  return text
    .split(/\r?\n/)
    .map((l) => `${prefix}${l}`.trimEnd())
    .join('\n')
}

const squeeze = (text: string): string => text.replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, '\n\n')

/** Renders a template set over an exported project (editor data left out). */
export function generate(file: FileProject, set: TemplateSet): Generation {
  const ctx = buildContext(file)
  const { manifest } = set
  const files: GeneratedFile[] = []
  const paths = new Set<string>()
  const scope: Record<string, unknown> = {
    ...ctx,
    files: [] as string[],
    generator: { name: manifest.name, reserved: manifest.reserved }
  }
  const templates = manifest.trimTagLines
    ? Object.fromEntries(Object.entries(set.files).map(([k, v]) => [k, trimTagLines(v)]))
    : set.files
  const liquid = createEngine(templates, scope)

  for (const out of manifest.outputs) {
    const where = (item?: unknown): string =>
      `${out.template}${item && typeof item === 'object' && 'name' in item ? ` (${String(item.name)})` : ''}`
    const fail = (e: unknown, item?: unknown): never => {
      throw new GenerationError(`${where(item)}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const attempt = <T>(f: () => T): T => {
      try {
        return f()
      } catch (e) {
        return fail(e)
      }
    }
    if (!(out.template in set.files)) fail(new Error('template not found'))
    const template = attempt(() => liquid.parse(templates[out.template]!, out.template))
    const list = out.each ? attempt(() => liquid.evalValueSync(out.each!, scope) as unknown) : [undefined]
    if (!Array.isArray(list)) fail(new Error(`'each: ${out.each}' is not a list`))
    const items = list as unknown[]
    const comment = out.comment ?? manifest.comment
    for (const item of items) {
      const local = out.each ? { ...scope, [out.as]: item } : scope
      try {
        if (out.when && !isTruthy(liquid.evalValueSync(out.when, local))) continue
        const path = outputPath(String(liquid.parseAndRenderSync(out.path, local)))
        if (paths.has(path)) throw new Error(`'${path}' is generated twice`)
        paths.add(path)
        let text = dropLines(String(liquid.renderSync(template, local)))
        if (manifest.squeezeBlankLines) text = squeeze(text)
        text = placeMarkers(text, comment)
          .replace(/^\s*\n/, '')
          .replace(/\s*$/, '\n')
        files.push({ path, text, comment })
        ;(scope.files as string[]).push(path)
      } catch (e) {
        fail(e, item)
      }
    }
  }
  return { files, warnings: [...ctx.warnings, ...reservedNames(ctx, manifest.reserved)] }
}

/** Liquid truthiness: only false and nil are false. */
const isTruthy = (v: unknown): boolean => v !== false && v !== null && v !== undefined
