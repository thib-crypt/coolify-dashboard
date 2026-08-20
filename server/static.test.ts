import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { Hono } from 'hono'
import { mountStatic, resolveStaticDir } from './static'

/** A `dist/` the way Vite leaves one: a shell plus fingerprinted assets. */
function buildDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coolify-dashboard-static-'))
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>')
  fs.writeFileSync(path.join(root, 'assets', 'index-B7dK2p1x.js'), 'console.log(1)')
  fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>')
  temporary.push(root)
  return root
}

const temporary: string[] = []
after(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveStaticDir', () => {
  it('accepts a directory that holds a built index.html', () => {
    const root = buildDir()
    assert.equal(resolveStaticDir(root), root)
  })

  it('refuses a directory that was never built into', () => {
    const root = buildDir()
    fs.rmSync(path.join(root, 'index.html'))
    assert.equal(resolveStaticDir(root), null)
  })

  it('stays off when no directory was configured', () => {
    assert.equal(resolveStaticDir(null), null)
    assert.equal(resolveStaticDir(''), null)
  })
})

describe('mountStatic', () => {
  const app = new Hono()
  app.get('/app/health', c => c.json({ ok: true }))
  app.all('/app/*', c => c.json({ error: 'No such endpoint.' }, 404))
  mountStatic(app, buildDir())

  it('serves a built asset', async () => {
    const res = await app.request('/assets/index-B7dK2p1x.js')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'console.log(1)')
  })

  it('lets a fingerprinted asset be cached forever, and the shell never', async () => {
    const asset = await app.request('/assets/index-B7dK2p1x.js')
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')

    for (const url of ['/', '/favicon.svg']) {
      const res = await app.request(url)
      assert.equal(res.headers.get('cache-control'), 'no-cache', url)
    }
  })

  it('answers an unknown path with the shell, so deep links survive a reload', async () => {
    const res = await app.request('/applications/some-uuid')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await res.text(), /id="root"/)
  })

  it('leaves the API alone — a typo there is a JSON 404, not the shell', async () => {
    const ok = await app.request('/app/health')
    assert.deepEqual(await ok.json(), { ok: true })

    const missing = await app.request('/app/nope')
    assert.equal(missing.status, 404)
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/)
  })

  it('does not serve anything outside the build directory', async () => {
    const res = await app.request('/../package.json')
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  })
})
