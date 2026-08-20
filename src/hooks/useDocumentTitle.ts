import { useEffect } from 'react'

/**
 * The tab title follows the page. It matters more here than in most apps:
 * this is a dashboard people leave open in a pinned tab next to Coolify's own,
 * and "Coolify — Overview" on every page makes the two indistinguishable.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `Coolify — ${title}`
  }, [title])
}
