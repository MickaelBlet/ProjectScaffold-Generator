// Code generation from a project file: npm run generate -- <project file> [options]
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  formatReport,
  generateInto,
  generationInput,
  templateSetFor,
  type OutputDir
} from '../src/renderer/src/codegen/run'
import { loadTemplateSet, type TemplateSet } from '../src/renderer/src/codegen/templateSet'
import { snake } from '../src/renderer/src/codegen/filters'
import { dependencyName } from '../src/renderer/src/model/dependencies'
import { formatFromPath, loadText } from '../src/renderer/src/model/serialize'
import type { Project } from '../src/renderer/src/model/types'

const USAGE = `Usage: npm run generate -- <project file> [options]

Options:
  -o, --out <dir>        output directory (default: generated/<project> next to the project file)
  -t, --templates <dir>  template set (default: <out>/.scaffold/templates if present, else cpp17)
  -d, --deps             also generate the dependencies, each in a sibling directory of <out>
  -f, --force            overwrite files changed outside their user sections
  -p, --prune            delete the files no longer generated (user code kept in .orphans files)
  -n, --dry-run          report only, write nothing
  -h, --help`

const BUILTIN = resolve(import.meta.dirname, '../templates/cpp17')

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export function nodeDir(root: string): OutputDir {
  return {
    label: relative(process.cwd(), root) || '.',
    read: (path) => readOrNull(join(root, path)),
    write: async (path, text) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    },
    remove: (path) => rm(join(root, path), { force: true })
  }
}

const templatesFrom = (dir: string): Promise<TemplateSet> =>
  loadTemplateSet((path) => readOrNull(join(dir, path)))

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      templates: { type: 'string', short: 't' },
      deps: { type: 'boolean', short: 'd' },
      force: { type: 'boolean', short: 'f' },
      prune: { type: 'boolean', short: 'p' },
      'dry-run': { type: 'boolean', short: 'n' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  if (values.help || positionals.length !== 1) {
    console.log(USAGE)
    return values.help ? 0 : 2
  }
  const options = { force: values.force, prune: values.prune, dryRun: values['dry-run'] }
  const done = new Set<string>()
  let failed = false

  const fail = (file: string, e: unknown): void => {
    console.error(`${relative(process.cwd(), file)}: error: ${e instanceof Error ? e.message : String(e)}`)
    failed = true
  }

  const run = async (file: string, out: string | undefined): Promise<void> => {
    if (done.has(file)) return
    done.add(file)
    let project: Project
    try {
      project = loadText(await readFile(file, 'utf8'), formatFromPath(file))
    } catch (e) {
      return fail(file, e)
    }
    const outDir = resolve(out ?? join(dirname(file), 'generated', snake(dependencyName(project.name))))
    try {
      const input = generationInput(project)
      const dir = nodeDir(outDir)
      const set = values.templates
        ? await templatesFrom(resolve(values.templates))
        : await templateSetFor(dir, () => templatesFrom(BUILTIN))
      const report = await generateInto(input, set, dir, options)
      console.log(formatReport(report, `${relative(process.cwd(), file)} -> ${dir.label}`))
      if (report.conflicts.length) failed = true
    } catch (e) {
      fail(file, e)
    }
    // Next to the project's directory, where its CMakeLists.txt looks for them.
    if (values.deps)
      for (const d of project.dependencies)
        await run(resolve(dirname(file), d.file), join(dirname(outDir), snake(d.name)))
  }

  await run(resolve(positionals[0]!), values.out)
  return failed ? 1 : 0
}

process.exitCode = await main()
