import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { HealthResponse } from '../shared/bff'

const PORT = Number(process.env.PORT ?? 8787)

const app = new Hono()

app.get('/app/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    service: 'coolify-dashboard-bff',
    now: new Date().toISOString(),
  }
  return c.json(body)
})

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`BFF listening on http://127.0.0.1:${info.port}`)
})
