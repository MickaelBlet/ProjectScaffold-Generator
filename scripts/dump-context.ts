// Parity check of the Rust rewrite: prints the generation context of a project file as JSON
// (keys in their order: map values keep theirs), or `error: <message>`. Removed once the TypeScript generator is.
import { readFileSync } from 'node:fs'
import { buildContext } from '../src/codegen/context'
import { generationInput } from '../src/codegen/run'
import { formatFromPath, loadText } from '../src/model/serialize'

/** An object inside itself (recursive types) as `<cycle>`. */
const stack = new Set<unknown>()
const acyclic = (v: unknown): unknown => {
  if (!v || typeof v !== 'object') return v
  if (stack.has(v)) return '<cycle>'
  stack.add(v)
  const r = Array.isArray(v)
    ? v.map(acyclic)
    : Object.fromEntries(
        Object.keys(v).map((k) => [k, acyclic((v as Record<string, unknown>)[k])])
      )
  stack.delete(v)
  return r
}

const file = process.argv[2]!
try {
  const ctx = buildContext(generationInput(loadText(readFileSync(file, 'utf8'), formatFromPath(file))))
  console.log(JSON.stringify(acyclic(ctx), null, 1))
} catch (e) {
  console.log(`error: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
}
