#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const docsRoot = path.join(repoRoot, 'docs')

const requiredFiles = [
  'README.md',
  'docs/README.md',
  'docs/BRIEF.md',
  'docs/API.md',
  'docs/architecture.md',
  'docs/operations.md',
  'docs/TROUBLESHOOTING.md',
  'docs/GLOSSARY.md',
  'docs/PHILOSOPHY.md',
  'docs/CONTRIBUTING.md',
  'docs/adr/README.md',
  'docs/adr/ADR-001-process-local-at-least-once-queue.md',
  'docs/adr/TEMPLATE.md'
]

for (const relativePath of requiredFiles) {
  assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `required documentation missing: ${relativePath}`)
}

const rootReadme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
const docsMap = fs.readFileSync(path.join(docsRoot, 'README.md'), 'utf8')
for (const requiredLink of ['docs/README.md', 'docs/API.md', 'docs/operations.md', 'docs/CONTRIBUTING.md']) {
  assert.ok(rootReadme.includes(requiredLink), `README.md must link ${requiredLink}`)
}
for (const requiredSection of ['## Reading paths by role', '## Document catalog', '## Documentation conventions', '## Source-of-truth matrix']) {
  assert.ok(docsMap.includes(requiredSection), `docs/README.md must include ${requiredSection}`)
}

function walkMarkdown(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) walkMarkdown(fullPath, result)
    else if (entry.name.endsWith('.md')) result.push(fullPath)
  }
  return result
}

function headingSlugs(filePath) {
  const slugs = new Set()
  const counts = new Map()
  const content = fs.readFileSync(filePath, 'utf8')
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    slugs.add(count ? `${base}-${count}` : base)
  }
  return slugs
}

const markdownFiles = [path.join(repoRoot, 'README.md'), ...walkMarkdown(docsRoot)]
const markdownLink = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const brokenLinks = []

for (const markdownFile of markdownFiles) {
  const content = fs.readFileSync(markdownFile, 'utf8')
  let match
  while ((match = markdownLink.exec(content)) !== null) {
    const target = match[1]
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/i.test(target)) continue
    const [cleanTarget, fragment] = target.split('#', 2)
    const resolved = path.resolve(path.dirname(markdownFile), cleanTarget)
    if (!fs.existsSync(resolved)) {
      brokenLinks.push(`${path.relative(repoRoot, markdownFile)} → ${target}`)
      continue
    }
    if (fragment && fs.statSync(resolved).isFile() && resolved.endsWith('.md')) {
      let decodedFragment
      try { decodedFragment = decodeURIComponent(fragment) } catch { decodedFragment = fragment }
      if (!headingSlugs(resolved).has(decodedFragment)) {
        brokenLinks.push(`${path.relative(repoRoot, markdownFile)} → ${target} (missing heading)`)
      }
    }
  }
}

assert.deepEqual(brokenLinks, [], `broken documentation links:\n${brokenLinks.join('\n')}`)
console.log(`docs:check OK — ${markdownFiles.length} Markdown files, ${requiredFiles.length} required documents`)
