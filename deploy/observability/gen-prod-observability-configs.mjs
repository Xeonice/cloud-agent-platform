#!/usr/bin/env node
// Generate / validate the inline observability `configs:` block in docker-compose.prod.yml
// from the CANONICAL source files under deploy/observability/.
//
// Why: the source-free run package (docker-compose.prod.yml) ships the observability config
// INLINE (compose `configs.<name>.content:`) instead of bind-mounting deploy/observability/*,
// so it stays a single source-free file. Hand-maintaining ~290 lines of YAML-in-YAML is
// drift-prone, and any literal `$` in the embedded content (Grafana's ${GRAFANA_PG_*} runtime
// tokens, the dashboard's $taskId template var) is eaten by Compose's render-time interpolation
// unless doubled to `$$`. This generator is the single transform that gets both right.
//
//   node deploy/observability/gen-prod-observability-configs.mjs --write   # rewrite the block
//   node deploy/observability/gen-prod-observability-configs.mjs --check   # CI: fail on drift
//
// The block it owns in docker-compose.prod.yml lives strictly between these marker lines:
//   # >>> GENERATED OBSERVABILITY CONFIGS — do not hand-edit (source: deploy/observability/*) >>>
//   # <<< GENERATED OBSERVABILITY CONFIGS <<<

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PROD = join(REPO, 'docker-compose.prod.yml')

const START = '# >>> GENERATED OBSERVABILITY CONFIGS — do not hand-edit (source: deploy/observability/*) >>>'
const END = '# <<< GENERATED OBSERVABILITY CONFIGS <<<'

// config name -> canonical source file (the order is the emitted order)
const SOURCES = [
  ['loki-config', 'loki-config.yaml'],
  ['alloy-config', 'alloy-config.alloy'],
  ['grafana-datasources', 'grafana/provisioning/datasources/datasources.yaml'],
  ['grafana-dashprovider', 'grafana/provisioning/dashboards/dashboards.yaml'],
  ['grafana-dashboard', 'grafana/dashboards/cap-observability.json'],
]

// Embed a file body under a YAML `    content: |` block scalar.
// - escape EVERY `$` to `$$` so Compose render-time interpolation leaves the literal in place
//   (Grafana then does its OWN ${VAR} / $var expansion at runtime).
// - indent each non-empty line by 6 spaces (under `  <name>:` / `    content: |`); keep blank
//   lines blank. This preserves the source's relative indentation byte-for-byte.
function emitConfig(name, body) {
  const escaped = body.replace(/\$/g, '$$$$') // $ -> $$ (in a JS replacement string $$ == one $)
  const lines = escaped.split('\n')
  // drop a single trailing empty line from the file's final newline so we don't emit a stray blank
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const indented = lines.map((l) => (l.length ? '      ' + l : '')).join('\n')
  return `  ${name}:\n    content: |\n${indented}\n`
}

function generateBlock() {
  let out = `${START}\n`
  out += '# regenerate: node deploy/observability/gen-prod-observability-configs.mjs --write\n'
  out += 'configs:\n'
  for (const [name, rel] of SOURCES) {
    const body = readFileSync(join(HERE, rel), 'utf8')
    out += emitConfig(name, body)
  }
  out += END
  return out
}

function spliceBlock(file, block) {
  const lines = file.split('\n')
  const s = lines.findIndex((l) => l.trim() === START)
  const e = lines.findIndex((l) => l.trim() === END)
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`markers not found in docker-compose.prod.yml (START@${s} END@${e}); add the sentinel block first`)
  }
  return [...lines.slice(0, s), ...block.split('\n'), ...lines.slice(e + 1)].join('\n')
}

const mode = process.argv[2]
const current = readFileSync(PROD, 'utf8')
const block = generateBlock()
const next = spliceBlock(current, block)

if (mode === '--write') {
  if (next === current) {
    console.log('observability configs already in sync — no change')
  } else {
    writeFileSync(PROD, next)
    console.log('observability configs regenerated into docker-compose.prod.yml')
  }
} else if (mode === '--check') {
  if (next !== current) {
    console.error('DRIFT: docker-compose.prod.yml observability configs are out of sync with deploy/observability/*')
    console.error('       run: node deploy/observability/gen-prod-observability-configs.mjs --write')
    process.exit(1)
  }
  // belt-and-braces: no un-doubled single `$` may survive inside the generated block
  const blockText = next.slice(next.indexOf(START), next.indexOf(END))
  if (/(^|[^$])\$([^$]|$)/m.test(blockText)) {
    console.error('UNESCAPED `$` found in generated observability configs (must be doubled to `$$`)')
    process.exit(1)
  }
  console.log('observability configs in sync and `$`-escaped — OK')
} else {
  console.error('usage: gen-prod-observability-configs.mjs --write|--check')
  process.exit(2)
}
