// Generation into a directory: user sections of the files already there are carried over, files
// changed outside their user sections are left alone (conflicts), and a record of what was
// generated (`.scaffold-gen.json`) tells hand edits and files no longer generated apart.
import { generate, GenerationError } from './generate'
import {
  extractSections,
  formatOrphans,
  hash,
  mergeSections,
  sectionHash,
  skeleton,
  type Section
} from './sections'
import { loadTemplateSet, type TemplateSet } from './templateSet'
import { toFile } from '../model/serialize'
import { validate } from '../model/validate'
import type { FileProject } from '../model/schema'
import type { Project } from '../model/types'

/** Directory generated files are written to; paths are relative and `/`-separated. */
export interface OutputDir {
  /** Shown in reports. */
  label: string
  /** Content of a file; null when it does not exist. */
  read(path: string): Promise<string | null>
  /** Writes a file, creating its directories. */
  write(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
  /** Opens a file in the host's own editor (VS Code); absent when the page edits it. */
  open?(path: string): void
}

export const RECORD = '.scaffold-gen.json'
/** Template set of an output directory, used instead of the built-in one. */
export const LOCAL_TEMPLATES = '.scaffold/templates'
export const ORPHANS = '.orphans'

interface RecordEntry {
  /** Hash of the file with its user sections emptied. */
  hash: string
  /** Hash of the generated (default) content of each user section. */
  sections: Record<string, string>
}

interface GenRecord {
  generator: string
  files: Record<string, RecordEntry>
}

export interface RunOptions {
  /** Overwrite files changed outside their user sections. */
  force?: boolean
  /** Delete files no longer generated (their user code is kept in `.orphans` files). */
  prune?: boolean
  /** Report only, write nothing. */
  dryRun?: boolean
}

export interface GenerationReport {
  written: string[]
  unchanged: string[]
  /** Files changed outside their user sections, left as they are. */
  conflicts: { path: string; reason: string }[]
  /** User sections with no place in the new file, saved to `<path>.orphans`. */
  orphans: { path: string; ids: string[] }[]
  /** Files generated before and no longer. */
  stale: string[]
  removed: string[]
  warnings: string[]
}

/** The project as given to templates; throws when it has errors (like export). */
export function generationInput(p: Project): FileProject {
  const errors = validate(p).filter((pr) => pr.severity === 'error')
  if (errors.length)
    throw new GenerationError(
      `the project has ${errors.length} error${errors.length > 1 ? 's' : ''}:\n${errors.map((e) => `  ${e.message}`).join('\n')}`
    )
  return toFile(p, { editor: false })
}

/** The output directory's own template set if it has one, else `fallback`. */
export async function templateSetFor(
  dir: OutputDir,
  fallback: () => Promise<TemplateSet> | TemplateSet
): Promise<TemplateSet> {
  if ((await dir.read(`${LOCAL_TEMPLATES}/manifest.yaml`)) === null) return fallback()
  return loadTemplateSet((path) => dir.read(`${LOCAL_TEMPLATES}/${path}`))
}

function entryOf(text: string, comment: string): RecordEntry {
  return {
    hash: hash(skeleton(text, comment)),
    sections: Object.fromEntries(extractSections(text, comment).map((s) => [s.id, sectionHash(s.content)]))
  }
}

/** Sections holding something else than what was generated in them. */
const edited = (sections: Section[], entry: RecordEntry | undefined): Section[] =>
  sections.filter((s) => s.content.trim() && entry?.sections[s.id] !== sectionHash(s.content))

export async function generateInto(
  file: FileProject,
  set: TemplateSet,
  dir: OutputDir,
  options: RunOptions = {}
): Promise<GenerationReport> {
  const { files, warnings } = generate(file, set)
  const report: GenerationReport = {
    written: [],
    unchanged: [],
    conflicts: [],
    orphans: [],
    stale: [],
    removed: [],
    warnings
  }
  const previousRecord = await readRecord(dir)
  const record: GenRecord = { generator: set.manifest.name, files: {} }
  const write = async (path: string, text: string): Promise<void> => {
    if (!options.dryRun) await dir.write(path, text)
  }
  const saveOrphans = async (path: string, sections: Section[], comment: string): Promise<void> => {
    if (!sections.length) return
    report.orphans.push({ path, ids: sections.map((s) => s.id) })
    const target = path + ORPHANS
    const before = (await dir.read(target)) ?? ''
    await write(
      target,
      `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${formatOrphans(sections, comment, path)}`
    )
  }

  for (const f of files) {
    const previous = await dir.read(f.path)
    const entry = previousRecord?.files[f.path]
    const next = entryOf(f.text, f.comment)
    if (previous === null) {
      await write(f.path, f.text)
      report.written.push(f.path)
      record.files[f.path] = next
      continue
    }
    let merged
    try {
      merged = mergeSections(
        f.text,
        previous,
        f.comment,
        (s) => entry?.sections[s.id] === sectionHash(s.content)
      )
    } catch (e) {
      if (!options.force) {
        report.conflicts.push({ path: f.path, reason: e instanceof Error ? e.message : String(e) })
        if (entry) record.files[f.path] = entry
        continue
      }
      merged = { text: f.text, orphans: [] }
    }
    // Against the last generation when recorded, else against this one.
    const handEdited = entry
      ? hash(skeleton(previous, f.comment)) !== entry.hash
      : skeleton(previous, f.comment) !== skeleton(f.text, f.comment)
    if (handEdited && !options.force) {
      report.conflicts.push({
        path: f.path,
        reason: entry
          ? 'changed outside its user sections'
          : 'differs outside its user sections (no generation record)'
      })
      if (entry) record.files[f.path] = entry
      continue
    }
    await saveOrphans(f.path, edited(merged.orphans, entry), f.comment)
    if (previous === merged.text) report.unchanged.push(f.path)
    else {
      await write(f.path, merged.text)
      report.written.push(f.path)
    }
    record.files[f.path] = next
  }

  // Files generated before and no longer.
  const comments = new Map(files.map((f) => [f.path, f.comment]))
  for (const [path, entry] of Object.entries(previousRecord?.files ?? {})) {
    if (comments.has(path)) continue
    const previous = await dir.read(path)
    if (previous === null) continue
    if (!options.prune) {
      report.stale.push(path)
      record.files[path] = entry
      continue
    }
    const comment = commentOf(previous, set.manifest.comment)
    if (hash(skeleton(previous, comment)) !== entry.hash && !options.force) {
      report.conflicts.push({ path, reason: 'no longer generated, and changed outside its user sections' })
      record.files[path] = entry
      continue
    }
    await saveOrphans(path, edited(extractSections(previous, comment), entry), comment)
    if (!options.dryRun) await dir.remove(path)
    report.removed.push(path)
  }

  if (!options.dryRun) await dir.write(RECORD, JSON.stringify(sortRecord(record), null, 2) + '\n')
  return report
}

/** Files generated into a directory (its record), and the `.orphans` files kept beside them. */
export async function generatedFiles(dir: OutputDir): Promise<string[]> {
  const files = Object.keys((await readRecord(dir))?.files ?? {})
  const orphans = await Promise.all(
    files.map(async (f) => ((await dir.read(f + ORPHANS)) === null ? [] : [f + ORPHANS]))
  )
  return [...files, ...orphans.flat()].sort()
}

async function readRecord(dir: OutputDir): Promise<GenRecord | null> {
  const text = await dir.read(RECORD)
  if (text === null) return null
  try {
    const r = JSON.parse(text) as GenRecord
    return r && typeof r.files === 'object' ? r : null
  } catch {
    return null
  }
}

const sortRecord = (r: GenRecord): GenRecord => ({
  generator: r.generator,
  files: Object.fromEntries(Object.entries(r.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
})

/** Comment of the markers of a file no longer generated: guessed from its first marker. */
export function commentOf(text: string, fallback: string): string {
  const m = /^[ \t]*(\S+)[ \t]*<user:[^\s<>]+>[ \t]*\r?$/m.exec(text)
  return m ? m[1]! : fallback
}

/** One line per file and problem, for the CLI and the app (`written`: list the files written). */
export function formatReport(r: GenerationReport, dir: string, written = true): string {
  const lines: string[] = []
  const list = (title: string, items: string[]): void => {
    if (items.length) lines.push(`${title} (${items.length}):`, ...items.map((i) => `  ${i}`))
  }
  if (written) list('Written', r.written)
  list('Removed', r.removed)
  list(
    'Conflicts, left as they are (force to overwrite)',
    r.conflicts.map((c) => `${c.path}: ${c.reason}`)
  )
  list(
    'User sections with no place left, saved to .orphans files',
    r.orphans.map((o) => `${o.path}: ${o.ids.join(', ')}`)
  )
  list('No longer generated (prune to delete)', r.stale)
  list('Warnings', r.warnings)
  lines.push(
    `${dir}: ${r.written.length} written, ${r.unchanged.length} unchanged, ${r.conflicts.length} conflicts`
  )
  return lines.join('\n')
}
