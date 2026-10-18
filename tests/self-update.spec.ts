import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { progress } from '../src/dsh-cli.ts'
import {
  cancelSelfUpdate,
  isSelfUpdateTarget,
  runSelfUpdate,
  selfUpdateRunning,
  type SpawnSelfUpdate,
} from '../src/self-update.ts'

const roots: string[] = []

function profile(dependencies: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-self-update-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
  return dir
}

function fakeSpawn(): { spawn: SpawnSelfUpdate; child: EventEmitter & { stdout: Readable; stderr: Readable; pid?: number; kill: ReturnType<typeof vi.fn> } } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable
    stderr: Readable
    pid?: number
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new Readable({ read() { /* test stream */ } })
  child.stderr = new Readable({ read() { /* test stream */ } })
  child.kill = vi.fn()
  const spawn: SpawnSelfUpdate = () => child as never
  return { spawn, child }
}

beforeEach(() => {
  progress.active = false
  progress.error = null
  progress.cancelling = false
})

afterEach(() => {
  cancelSelfUpdate()
  progress.active = false
  progress.error = null
  progress.cancelling = false
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('market self-update target', () => {
  it('recognizes the npm package names', () => {
    const dir = profile({ dshmarket: '1.66.38' })
    expect(isSelfUpdateTarget('desktop', dir, 'dshmarket@1.66.39')).toBe(true)
    expect(isSelfUpdateTarget('desktop', dir, 'dsh-market@1.66.39')).toBe(true)
    expect(isSelfUpdateTarget('desktop', dir, 'example@2.0.0')).toBe(false)
  })

  it('recognizes a git-hosted fork by repository, not by the raw spec', () => {
    const dir = profile({ dshmarket: 'github:super-qiuqiu/dsh-market#0123456789abcdef' })
    expect(isSelfUpdateTarget('desktop', dir, 'github:super-qiuqiu/dsh-market')).toBe(true)
    expect(isSelfUpdateTarget('desktop', dir, 'github:super-qiuqiu/dsh-market#another-ref')).toBe(true)
    expect(isSelfUpdateTarget('desktop', dir, 'github:someone-else/dsh-market')).toBe(false)
  })

  it('does not treat a linked checkout as a self update without a repository', () => {
    const dir = profile({ dshmarket: 'link:../dsh-market' })
    expect(isSelfUpdateTarget('desktop', dir, 'github:super-qiuqiu/dsh-market')).toBe(false)
  })
})

describe('runSelfUpdate', () => {
  it('runs the host pnpm with the workspace flag, the profile cwd and CI mode', async () => {
    const dir = profile({ dshmarket: '1.66.38' })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const { spawn, child } = fakeSpawn()
    let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null
    const spawnImpl: SpawnSelfUpdate = (command, args, options) => {
      invocation = { command, args, options }
      return child as never
    }

    const pending = runSelfUpdate(dir, 'dshmarket@1.66.39', { command: '/host/node', args: ['--expose-internals', '/host/pnpm.mjs'], env: { PATH: '/host/bin' } }, spawnImpl)
    expect(selfUpdateRunning()).toBe(true)
    child.emit('close', 0)
    const result = await pending

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, wroteNothing: false })
    expect(invocation).not.toBeNull()
    expect(invocation!.command).toBe('/host/node')
    expect(invocation!.args).toEqual(['--expose-internals', '/host/pnpm.mjs', 'add', '-w', 'dshmarket@1.66.39'])
    expect(invocation!.options.cwd).toBe(dir)
    expect((invocation!.options.env as NodeJS.ProcessEnv).CI).toBe('1')
    expect((invocation!.options.env as NodeJS.ProcessEnv).PATH).toBe('/host/bin')
    expect(selfUpdateRunning()).toBe(false)
    expect(progress.active).toBe(false)
  })

  it('omits -w outside a pnpm workspace', async () => {
    const dir = profile({ dshmarket: '1.66.38' })
    const { child } = fakeSpawn()
    let args: string[] = []
    const spawnImpl: SpawnSelfUpdate = (_command, nextArgs) => {
      args = nextArgs
      return child as never
    }
    const pending = runSelfUpdate(dir, 'dshmarket@1.66.39', { command: 'node', args: ['pnpm.mjs'], env: {} }, spawnImpl)
    child.emit('close', 0)
    await pending
    expect(args).toEqual(['pnpm.mjs', 'add', 'dshmarket@1.66.39'])
  })

  it('reports wroteNothing only when pnpm never started', async () => {
    const dir = profile({ dshmarket: '1.66.38' })
    const spawnImpl: SpawnSelfUpdate = () => {
      throw new Error('spawn ENOENT')
    }
    const result = await runSelfUpdate(dir, 'dshmarket@1.66.39', { command: 'missing', args: [], env: {} }, spawnImpl)
    expect(result).toMatchObject({ exitCode: 127, wroteNothing: true })
    expect(result.stderr).toContain('ENOENT')
    expect(selfUpdateRunning()).toBe(false)
  })

  it('leaves a failed run restorable instead of claiming nothing was written', async () => {
    const dir = profile({ dshmarket: '1.66.38' })
    const { child } = fakeSpawn()
    const pending = runSelfUpdate(dir, 'dshmarket@1.66.39', { command: 'node', args: ['pnpm.mjs'], env: {} }, () => child as never)
    child.stderr.emit('data', Buffer.from('ERR_PNPM_FETCH_404'))
    child.emit('close', 1)
    const result = await pending
    expect(result).toMatchObject({ exitCode: 1, wroteNothing: false })
    expect(progress.error).toContain('ERR_PNPM_FETCH_404')
  })

  it('cancels the pnpm process and reports the run as cancelled', async () => {
    const dir = profile({ dshmarket: '1.66.38' })
    const { child } = fakeSpawn()
    const pending = runSelfUpdate(dir, 'dshmarket@1.66.39', { command: 'node', args: ['pnpm.mjs'], env: {} }, () => child as never)
    expect(cancelSelfUpdate()).toBe(true)
    expect(progress.cancelling).toBe(true)
    child.emit('close', 1)
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(selfUpdateRunning()).toBe(false)
    expect(cancelSelfUpdate()).toBe(false)
  })
})
