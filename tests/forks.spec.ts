import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const latest = vi.hoisted(() => new Map<string, string | null>())

vi.mock('../src/updates.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/updates.ts')>()
  return {
    ...actual,
    fetchNpmLatest: (name: string) => Promise.resolve(latest.get(name) ?? null),
  }
})

import { checkForkUpstreams, hasLocalForkMarker, readForkUpstreamConfig } from '../src/forks.ts'

const roots: string[] = []

function makeProfile(dependencies: Record<string, string>, packages: Record<string, { version: string; repository?: string | { url: string } }>, forks?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-forks-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
  for (const [name, manifest] of Object.entries(packages)) {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, ...manifest }))
  }
  if (forks !== undefined) {
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'forks.json'), JSON.stringify(forks))
  }
  return dir
}

beforeEach(() => {
  latest.clear()
})

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fork marker', () => {
  it('recognizes the local conventions and leaves upstream prereleases alone', () => {
    expect(hasLocalForkMarker('0.25.0+qiuqiu.1')).toBe(true)
    expect(hasLocalForkMarker('0.5.4-fork.1')).toBe(true)
    expect(hasLocalForkMarker('0.5.4-local.2')).toBe(true)
    expect(hasLocalForkMarker('1.66.38-beta.1')).toBe(false)
    expect(hasLocalForkMarker('1.66.38')).toBe(false)
  })
})

describe('fork upstream config', () => {
  it('reads valid entries and drops malformed ones', () => {
    const dir = makeProfile({}, {}, {
      dshmarket: { npm: 'dshmarket', repo: 'dsh-market/dsh-market' },
      broken: { repo: 'not a repo' },
      empty: {},
    })
    expect(readForkUpstreamConfig(dir)).toEqual({
      dshmarket: { npm: 'dshmarket', repo: 'dsh-market/dsh-market' },
    })
  })

  it('returns an empty map for a missing or malformed file', () => {
    const dir = makeProfile({}, {})
    expect(readForkUpstreamConfig(dir)).toEqual({})
  })
})

describe('checkForkUpstreams', () => {
  it('tracks local link forks and explicit git forks, but not unrelated checkouts', async () => {
    latest.set('dsh-better-sidebar', '0.28.0')
    latest.set('dsh-context', '0.72.0')
    latest.set('dshmarket', '1.66.38')
    latest.set('dsh-custom', '9.9.9')
    const dir = makeProfile(
      {
        'dsh-better-sidebar': 'link:/work/better-sidebar',
        'dsh-context': 'link:/work/context',
        'dsh-custom': 'link:/work/custom',
        dshmarket: 'github:super-qiuqiu/dsh-market#self-update-runtime',
        example: '1.0.0',
      },
      {
        'dsh-better-sidebar': { version: '0.25.0+qiuqiu.1', repository: 'git+https://github.com/omdsh-dev/DSH-better-sidebar.git' },
        'dsh-context': { version: '0.72.0+qiuqiu.1', repository: { url: 'git+https://github.com/bowenliang123/dsh-context.git' } },
        'dsh-custom': { version: '1.2.3', repository: 'https://github.com/o/custom' },
        dshmarket: { version: '1.66.38', repository: 'git+https://github.com/dsh-market/dsh-market.git' },
        example: { version: '1.0.0' },
      },
      { dshmarket: { npm: 'dshmarket', repo: 'dsh-market/dsh-market' } },
    )

    const report = await checkForkUpstreams('desktop', dir)
    expect(report.checked).toBe(3)
    expect(Object.keys(report.forks).sort()).toEqual(['dsh-better-sidebar', 'dsh-context', 'dshmarket'])
    expect(report.forks['dsh-better-sidebar']).toMatchObject({
      installedVersion: '0.25.0+qiuqiu.1',
      upstreamVersion: '0.28.0',
      updateAvailable: true,
      repo: 'omdsh-dev/DSH-better-sidebar',
    })
    // Same base as upstream: the local +qiuqiu marker never makes it "behind".
    expect(report.forks['dsh-context']).toMatchObject({ upstreamVersion: '0.72.0', updateAvailable: false })
    expect(report.forks.dshmarket).toMatchObject({ upstreamVersion: '1.66.38', updateAvailable: false })
  })

  it('compares the release core, so a local prerelease marker is not behind the same release', async () => {
    latest.set('clearai-dsh', '0.5.4')
    const dir = makeProfile(
      { 'clearai-dsh': 'link:/work/clearai' },
      { 'clearai-dsh': { version: '0.5.4-fork.1', repository: 'git+https://github.com/Clearailhc/clearai-dsh.git' } },
    )
    const report = await checkForkUpstreams('desktop', dir)
    expect(report.forks['clearai-dsh']).toMatchObject({ upstreamVersion: '0.5.4', updateAvailable: false })
  })

  it('keeps an explicit entry with a repository when npm has no answer', async () => {
    const dir = makeProfile(
      { 'my-fork': 'link:/work/my-fork' },
      { 'my-fork': { version: '1.0.0+qiuqiu.1' } },
      { 'my-fork': { repo: 'me/my-fork' } },
    )
    const report = await checkForkUpstreams('desktop', dir)
    expect(report.forks['my-fork']).toEqual({
      installedVersion: '1.0.0+qiuqiu.1',
      upstreamVersion: null,
      updateAvailable: false,
      upstreamName: null,
      repo: 'me/my-fork',
    })
  })
})
