// User sections: parts of generated files kept across generations, between comment markers
//   // <user:Core.Sensor.setMode>
//   ...hand-written code...
//   // </user:Core.Sensor.setMode>
// Templates write them with `{% user 'id' %}default content{% enduser %}`.
import {
  Tag,
  TypeGuards,
  Value,
  type Context,
  type Emitter,
  type Liquid,
  type Template,
  type TagToken,
  type TopLevelToken,
  type Parser
} from 'liquidjs'

export class SectionError extends Error {}

// Markers written by the tag, turned into comment lines once the file is rendered.
const OPEN = '\uE000'
const CLOSE = '\uE001'
const SENTINEL = new RegExp(`${OPEN}([BE])([^${CLOSE}]*)${CLOSE}`)

export class UserTag extends Tag {
  private readonly id: Value
  private readonly templates: Template[] = []

  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remain, liquid)
    this.id = new Value(this.tokenizer.readFilteredValue(), liquid)
    while (remain.length) {
      const t = remain.shift()!
      if (TypeGuards.isTagToken(t) && t.name === 'enduser') return
      this.templates.push(parser.parseToken(t, remain))
    }
    throw new SectionError(`tag ${token.getText()} not closed`)
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const id = String(yield this.id.value(ctx, false))
    if (!/^[^\s<>]+$/.test(id)) throw new SectionError(`invalid user section id '${id}'`)
    const body = (yield this.liquid.renderer.renderTemplates(this.templates, ctx)) as string
    emitter.write(`${OPEN}B${id}${CLOSE}${body}${OPEN}E${id}${CLOSE}`)
  }
}

const leading = (s: string): string => /^[ \t]*/.exec(s)![0]

/**
 * Turns the tag markers of a rendered file into comment lines: each marker on a line of its own,
 * indented like the line where the section starts.
 */
export function placeMarkers(text: string, comment: string): string {
  const out: string[] = []
  const open: { id: string; indent: string }[] = []
  for (const raw of text.split('\n')) {
    let line: string | null = raw
    while (line !== null) {
      const m = SENTINEL.exec(line)
      if (!m) {
        out.push(line)
        break
      }
      const before = line.slice(0, m.index)
      const after = line.slice(m.index + m[0].length)
      const id = m[2]!
      let indent: string
      if (m[1] === 'B') {
        indent = leading(before)
        if (before.trim()) out.push(before.trimEnd())
        out.push(`${indent}${comment} <user:${id}>`)
        open.push({ id, indent })
      } else {
        const section = open.pop()
        if (section?.id !== id) throw new SectionError(`user section '${id}' closed out of order`)
        if (before.trim()) out.push(before)
        indent = section.indent
        out.push(`${indent}${comment} </user:${id}>`)
      }
      line = after.trim() ? indent + after.trimStart() : null
    }
  }
  if (open.length) throw new SectionError(`user section '${open[0]!.id}' not closed`)
  return out.join('\n')
}

export interface Section {
  id: string
  /** Lines between the markers, joined with '\n'. */
  content: string
  /** Line index of the opening and closing markers. */
  start: number
  end: number
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function markerRe(comment: string): RegExp {
  return new RegExp(`^[ \\t]*${escapeRe(comment)}[ \\t]*<(/?)user:([^\\s<>]+)>[ \\t]*\\r?$`)
}

/** User sections of a file, in order. */
export function extractSections(text: string, comment: string): Section[] {
  const re = markerRe(comment)
  const lines = text.split('\n')
  const sections: Section[] = []
  const seen = new Set<string>()
  let current: { id: string; start: number } | null = null
  lines.forEach((line, i) => {
    const m = re.exec(line)
    if (!m) return
    const [, close, id] = m as unknown as [string, string, string]
    if (!close) {
      if (current) throw new SectionError(`line ${i + 1}: user section '${id}' opened inside '${current.id}'`)
      if (seen.has(id)) throw new SectionError(`line ${i + 1}: user section '${id}' appears twice`)
      seen.add(id)
      current = { id, start: i }
    } else {
      if (current?.id !== id) throw new SectionError(`line ${i + 1}: unexpected end of user section '${id}'`)
      sections.push({
        id,
        content: lines.slice(current.start + 1, i).join('\n'),
        start: current.start,
        end: i
      })
      current = null
    }
  })
  if (current) throw new SectionError(`user section '${(current as { id: string }).id}' not closed`)
  return sections
}

/** The text with the content of each section replaced by `fill(section)`. */
function replaceSections(text: string, comment: string, fill: (s: Section) => string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let at = 0
  for (const s of extractSections(text, comment)) {
    out.push(...lines.slice(at, s.start + 1))
    const content = fill(s)
    if (content !== '') out.push(content)
    at = s.end
  }
  out.push(...lines.slice(at))
  return out.join('\n')
}

export interface MergeResult {
  text: string
  /** Sections of the previous file the new one has no place for. */
  orphans: Section[]
}

/**
 * Puts the user sections of the previous file into the newly generated one, by id; those still
 * holding what was generated in them (`untouched`) take the new default content instead.
 */
export function mergeSections(
  generated: string,
  previous: string | null,
  comment: string,
  untouched: (s: Section) => boolean = () => false
): MergeResult {
  if (previous === null) return { text: generated, orphans: [] }
  // The file keeps its line endings.
  const crlf = previous.includes('\r\n')
  const kept = new Map(extractSections(previous.replace(/\r\n/g, '\n'), comment).map((s) => [s.id, s]))
  const text = replaceSections(generated, comment, (s) => {
    const old = kept.get(s.id)
    kept.delete(s.id)
    return old && !untouched(old) ? old.content : s.content
  })
  return { text: crlf ? text.replace(/\r?\n/g, '\r\n') : text, orphans: [...kept.values()] }
}

/** The text with every section emptied: what a template generates, whatever the user wrote. */
export const skeleton = (text: string, comment: string): string =>
  replaceSections(text.replace(/\r\n/g, '\n'), comment, () => '')

/** Short non-cryptographic hash (cyrb53), hex. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** Normalized section content for comparisons: line endings and trailing blanks ignored. */
export const sectionHash = (content: string): string => hash(content.replace(/\r\n/g, '\n').trimEnd())

/** Orphan sections as a file of their own, markers included. */
export function formatOrphans(sections: Section[], comment: string, from: string): string {
  return sections
    .map(
      (s) =>
        `${comment} from ${from}\n${comment} <user:${s.id}>\n${s.content}${s.content ? '\n' : ''}${comment} </user:${s.id}>\n`
    )
    .join('\n')
}
