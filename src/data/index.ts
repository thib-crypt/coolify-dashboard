import { mockSource } from './mock'
import type { DataSource } from './types'

/* Single switch point between mock and live data.
   The UI stays on the mock until phase 1 rewrites src/data/coolify.ts to call the BFF. */
export const source: DataSource = mockSource

export * from './types'
