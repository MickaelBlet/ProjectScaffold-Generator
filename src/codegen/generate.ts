// Renders a template set over a project: the files to generate, with the default content of their
// user sections. Pure: merging with the files on disk is done by run.ts.
import { Liquid } from 'liquidjs'
import { buildContext, type GenContext } from './context'
import { cppFilters, cppWarnings } from './cpp'
import { caseFilters } from './filters'
import { placeMarkers, UserTag } from './sections'
import type { TemplateSet } from './templateSet'
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
  const p = path.trim().replace(/\/+/g, '/')
  if (!p || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p))
    throw new GenerationError(`invalid output path '${path}': must be relative and use '/'`)
  const parts = p.split('/').filter((s) => s !== '.')
  if (parts.some((s) => s === '..' || s === '')) throw new GenerationError(`invalid output path '${path}'`)
  return parts.join('/')
}

/** A line holding only one tag, `user` / `enduser` excepted (their lines place the markers). */
const TAG_LINE = /^[ \t]*(\{%-?(?![ \t]*(?:user|enduser)\b)(?:(?!%\})[^\n])*%\})[ \t]*\r?\n/gm

/** Like Jinja's trim_blocks + lstrip_blocks: tags on lines of their own leave nothing. */
export const trimTagLines = (template: string): string => template.replace(TAG_LINE, '$1')

// Written by filters whose output is empty, e.g. no description: the line holding it is dropped.
const DROP = '\uE002'
const dropLines = (text: string): string =>
  text.replace(new RegExp(`^[ \\t]*${DROP}[ \\t]*\\r?\\n`, 'gm'), '').replaceAll(DROP, '')

export function createEngine(set: TemplateSet, ctx: GenContext): Liquid {
  const templates = set.manifest.trimTagLines
    ? Object.fromEntries(Object.entries(set.files).map(([k, v]) => [k, trimTagLines(v)]))
    : set.files
  const liquid = new Liquid({
    templates,
    strictVariables: true,
    strictFilters: true,
    lenientIf: true,
    greedy: false
  })
  liquid.registerTag('user', UserTag)
  const filters = { ...caseFilters, ...cppFilters(ctx), doc_comment: docComment }
  for (const [name, f] of Object.entries(filters))
    liquid.registerFilter(name, (...args: unknown[]) => (f as (...a: unknown[]) => unknown)(...args))
  return liquid
}

/** Each line of a description after `prefix` (e.g. `  /// `); no line for no description. */
function docComment(text: string, prefix = '/// '): string {
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
  const liquid = createEngine(set, ctx)
  const { manifest } = set
  const files: GeneratedFile[] = []
  const paths = new Set<string>()
  const scope: Record<string, unknown> = { ...ctx, files: [] as string[], generator: { name: manifest.name } }

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
    const template = attempt(() => liquid.parseFileSync(out.template))
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
  return { files, warnings: [...ctx.warnings, ...(manifest.language === 'cpp' ? cppWarnings(ctx) : [])] }
}

/** Liquid truthiness: only false and nil are false. */
const isTruthy = (v: unknown): boolean => v !== false && v !== null && v !== undefined
