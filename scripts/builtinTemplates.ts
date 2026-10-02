// Built-in template sets (templates/<set>), read from the sources; embedded instead by scripts/build-cli.ts.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIR = resolve(import.meta.dirname, '../templates')

export async function readBuiltin(set: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(DIR, set, path), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
