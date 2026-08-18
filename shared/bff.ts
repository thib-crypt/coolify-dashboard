/** Contract between the React SPA and this repo's BFF (`/app/*`). */

export interface HealthResponse {
  ok: boolean
  service: 'coolify-dashboard-bff'
  now: string
}
