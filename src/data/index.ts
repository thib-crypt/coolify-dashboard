import { createBffSource } from './coolify'
import { mockSource } from './mock'
import type { DataSource } from './types'

/* Single switch point between live and mock data.
   Live is the default; set VITE_USE_MOCK=1 to develop the UI without an instance. */
export const source: DataSource = import.meta.env.VITE_USE_MOCK === '1' ? mockSource : createBffSource()

export * from './types'
