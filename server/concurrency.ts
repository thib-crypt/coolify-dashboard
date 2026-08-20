/** Runs `fn` over `items` with at most `limit` calls in flight, preserving order.
 *
 * Both fan-outs in this BFF are over a *fleet* — one call per application, one
 * per server — so they grow with the user's infrastructure. The limit is what
 * keeps a 40-application team from opening 40 sockets at once, upstream or out
 * to the public internet.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}
