import fs from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

/**
 * Serving the built SPA from the BFF is what makes the dashboard a single
 * container: the browser gets its HTML and its JSON from the same origin, so
 * there is no CORS to configure, no second service to deploy, and the SSE
 * stream is same-origin by construction.
 *
 * None of this runs in development — Vite serves the front end on 5180 and
 * proxies `/app` here, so `dist/` is usually absent or stale while coding.
 */

/**
 * Vite fingerprints every emitted asset (`index-B7dK2p1x.js`). Those names
 * change whenever their content does, which is the whole point of caching them
 * for a year; `index.html` is the one file that must never be cached, because
 * it is what points at the current fingerprints.
 */
const FINGERPRINTED = /[.-][0-9a-zA-Z_-]{8,}\.[a-z0-9]+$/

/** The built SPA, or null when there is nothing to serve (API-only mode). */
export function resolveStaticDir(dir: string | null | undefined): string | null {
  if (!dir) return null
  const root = path.resolve(dir)
  return fs.existsSync(path.join(root, 'index.html')) ? root : null
}

/**
 * Mount **after** the `/app/*` routes: the SPA fallback below answers anything
 * that is left, and an API typo must stay a JSON 404 rather than silently
 * returning the HTML shell.
 */
export function mountStatic(app: Hono, root: string): void {
  // Read once: the image that ships this file also ships the `dist/` beside it,
  // and a rebuild means a new process anyway.
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8')

  // Written on the way out, not from `serveStatic`'s `onFound`: that hook runs
  // once the response has already been built around the open file stream, so a
  // header set there lands on a copy nobody ever sends.
  app.use('/*', async (c, next) => {
    await next()
    if (c.res.status !== 200) return
    c.header(
      'Cache-Control',
      FINGERPRINTED.test(c.req.path) ? 'public, max-age=31536000, immutable' : 'no-cache',
    )
  })

  app.use('/*', serveStatic({ root }))

  // Whatever is left is a client-side route, not a missing file: the SPA owns
  // its own 404s, and a deep link must survive a browser reload.
  app.get('/*', c => c.html(index))
}
