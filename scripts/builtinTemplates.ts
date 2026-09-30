// Built-in template set (templates/cpp17), read from the sources; embedded instead by scripts/build-cli.ts.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIR = resolve(import.meta.dirname, '../templates/cpp17')

export async function readBuiltin(path: string): Promise<string | null> {
  try {
    return await readFile(join(DIR, path), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
