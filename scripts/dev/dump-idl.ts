// Prints the project file of an IDL file as the TypeScript reader gives it, with its warnings:
// npx tsx scripts/dev/dump-idl.ts <file.idl>   (compared with the Rust reader's `dump_idl` test)
import { readFile } from 'node:fs/promises'
import { idlProject, readIdlIncludes } from '../../src/model/idl'
import { toFile } from '../../src/model/serialize'

const path = process.argv[2]!
const text = await readFile(path, 'utf8')
const read = (p: string): Promise<string | null> => readFile(p, 'utf8').catch(() => null)
try {
  const files = await readIdlIncludes(new Map([[path, text]]), read)
  const { project, warnings } = idlProject(path, files)
  console.log(JSON.stringify({ file: toFile(project, { editor: false }), warnings }, null, 1))
} catch (e) {
  console.log(JSON.stringify({ error: (e as Error).message }, null, 1))
}
