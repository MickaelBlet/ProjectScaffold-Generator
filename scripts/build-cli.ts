// Builds the code generator into a standalone executable (Node single executable application):
// dist-cli/scaffold-gen.cjs (bundle, runs with node) and dist-cli/scaffold-gen[.exe] (no Node needed).
// Usage: tsx scripts/build-cli.ts [node binary to embed, default: this one]
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'dist-cli')
const TEMPLATES = join(ROOT, 'templates')
const node = resolve(process.argv[2] ?? process.execPath)
const exe = join(OUT, node.endsWith('.exe') ? 'scaffold-gen.exe' : 'scaffold-gen')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }

// Executables built from other node binaries (scaffold-gen, scaffold-gen.exe) are kept.
mkdirSync(OUT, { recursive: true })

// The built-in template sets go into the bundle, in place of scripts/builtinTemplates.ts.
const files = Object.fromEntries(
  readdirSync(TEMPLATES).flatMap((set) =>
    readdirSync(join(TEMPLATES, set)).map((f) => [
      `${set}/${f}`,
      readFileSync(join(TEMPLATES, set, f), 'utf8')
    ])
  )
)
const bundle = join(OUT, 'scaffold-gen.cjs')
await build({
  entryPoints: [join(ROOT, 'scripts/generate.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs', // single executable applications run CommonJS
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { VERSION: JSON.stringify(version) },
  logLevel: 'warning',
  plugins: [
    {
      name: 'builtin-templates',
      setup(b) {
        b.onLoad({ filter: /[\\/]scripts[\\/]builtinTemplates\.ts$/ }, () => ({
          loader: 'js',
          contents: `const FILES = ${JSON.stringify(files)}
export const readBuiltin = async (set, path) => (Object.hasOwn(FILES, set + '/' + path) ? FILES[set + '/' + path] : null)`
        }))
      }
    }
  ]
})
chmodSync(bundle, 0o755)

// Blob of the bundle injected into a copy of the node binary.
const blob = join(OUT, 'sea-prep.blob')
const config = join(OUT, 'sea-config.json')
writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }))
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })
copyFileSync(node, exe)
chmodSync(exe, 0o755)
execFileSync(
  process.execPath,
  [
    join(ROOT, 'node_modules/postject/dist/cli.js'),
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ],
  { stdio: 'inherit' }
)
rmSync(blob)
rmSync(config)
console.log(`wrote ${bundle}\nwrote ${exe}`)
