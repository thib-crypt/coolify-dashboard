# Development

## Getting started

Node ≥ 22.5 (24+ recommended — `node:sqlite` is available there without a flag).

```bash
npm install
npm run dev:mock        # SPA on http://localhost:5180, fixture data, no instance needed
```

`dev:mock` is the fastest way in: the whole UI runs on `src/data/mock.ts`, so you can work
on components without a Coolify token. For anything touching the server, point it at a real
instance:

```bash
cp .env.example .env    # COOLIFY_URL + COOLIFY_TOKEN
npm run dev             # SPA on :5180 and BFF on :8787, both watching
```

Vite proxies `/app` to `127.0.0.1:8787`, so the browser only ever talks to one origin — the
same arrangement as production, where the BFF serves the built SPA itself.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | SPA + BFF together (`concurrently`), both watching |
| `npm run dev:web` | SPA alone against a BFF you started yourself |
| `npm run dev:mock` | SPA alone on fixture data |
| `npm run dev:bff` | BFF alone, `tsx watch` |
| `npm test` | The whole suite (`node:test`), no network, ~0.5 s |
| `npm run test:watch` | Same, watching |
| `npm run typecheck` | Both TypeScript projects: `tsconfig.json` (SPA) and `tsconfig.server.json` |
| `npm run build` | Type-check, then bundle the SPA into `dist/` and the BFF into `dist-server/` |
| `npm start` | Run the built server, which serves the built SPA from `dist/` |

## Layout

The full map is in [architecture.md](architecture.md#layout). The short version:

- `shared/` is the contract. `dashboard.ts` is the model every component consumes,
  `bff.ts` is the `/app/*` API, `coolify-api.ts` is Coolify's shapes as they actually are.
- `server/` is the BFF. One concern per file, and each one owns its own defaults
  (`DEFAULT_PROBE_CONFIG`, `TTL`, `POLL_ACTIVE_MS`) so `config.ts` stays a translation layer
  from environment variables.
- `src/data/index.ts` is the single mock ↔ live switch. Components never know which one they
  are on.

## Tests

`node:test` through `tsx`, 205 of them, no network and no instance:

```bash
npm test
node --import tsx --test server/probes.test.ts      # one file
```

What the suite covers, and the shape of a good addition to it:

- **Mappers are pure functions**, so every Coolify parsing trap is a table of inputs and
  expected outputs — timezone-less timestamps, `"running:healthy"`, JSON-string logs, cron
  positions.
- **Everything with a clock takes the time as an argument.** No test sleeps.
- **Upstream is a fake `fetch`**, asserting on the request as much as on the response: the
  verb, the `Content-Type`, the fallback from POST to GET.
- **Rules are tested against state, not against a network.** `buildInsights` is a function
  of a snapshot.

If you add a behaviour that depends on a Coolify quirk, add the quirk to
[coolify-api-notes.md](coolify-api-notes.md) as well — the note is the durable half.

## Conventions

- **Comments say why.** One that restates the code gets deleted in review; one that records
  a trap, a measurement, or an alternative that was tried and rejected earns its place.
- **Never invent a number.** If the API cannot provide it, the UI shows `—` and a degraded
  note explains why. `notes` on `/app/overview` is a first-class output, not a debug aid.
- **The front end posts intents, not Coolify uuids' meaning.** Palette commands travel typed
  (`PaletteCommand`), never as strings to be re-parsed.
- **CSS lives next to its component**, and a media query lives in the file that holds the
  rule it overrides — so import order can never break the responsive layout.
- **No formatter or linter is configured.** Match the file you are editing: two-space
  indent, no semicolons, single quotes, and lines that wrap around 110 characters.

## Adding a field to the dashboard

The path is always the same, and the type checker walks you through it:

1. Add it to the `Dashboard` model in `shared/dashboard.ts`.
2. Add the fixture value in `src/data/mock.ts` — `npm run dev:mock` should show it before
   anything real does.
3. Map it in `server/coolify/mappers.ts` (pure, tested) and wire the source into
   `server/overview.ts`.
4. If it can be missing, push a `DegradedNote` rather than a default that reads like data.
5. Render it.

## Working without a Coolify instance

Beyond `dev:mock`, the server tests run a fake upstream, and `server/coolify/client.test.ts`
shows how to stand one up: a `fetch` stub that records calls and returns canned payloads.
That is how the deployment, webhook and metrics paths were verified end to end, including
the failure modes that are hard to produce on a real instance — a full queue, a regenerated
Sentinel token, a webhook retried five times.

## Before opening a pull request

```bash
npm run typecheck && npm test && npm run build
```

The same three commands run in CI, on Node 22 and 24. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
