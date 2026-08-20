# Contributing

Thanks for looking. Issues, questions and pull requests are all welcome — including
"the documentation is wrong about X", which is a real bug in a project whose whole premise
is saying only what it can prove.

## Before you start

For anything larger than a fix, **open an issue first**. Not as a formality: this codebase
has opinions about what it will and will not display (see [Principles](#principles) below),
and it is much cheaper to find out we disagree before you have written the code.

Check [docs/roadmap.md](docs/roadmap.md) too — the next two phases are planned in some
detail, and picking one up is the easiest way to help.

## Setting up

```bash
npm install
npm run dev:mock        # the whole UI on fixture data, no Coolify instance needed
```

[docs/development.md](docs/development.md) covers the rest: layout, scripts, how the tests
fake an upstream, and how to add a field end to end.

## Before you open a pull request

```bash
npm run typecheck && npm test && npm run build
```

CI runs exactly these, on Node 22 and 24. Also:

- **Add tests for behaviour.** Mappers are pure and everything with a clock takes time as an
  argument, so tests need neither network nor sleeps. A bug fix should come with the test
  that would have caught it.
- **Update the docs in the same commit.** A new environment variable belongs in
  `.env.example` *and* [docs/configuration.md](docs/configuration.md); a newly discovered
  Coolify quirk belongs in [docs/coolify-api-notes.md](docs/coolify-api-notes.md).
- **Keep commits focused**, with a message that says why in the body if the subject cannot.
  History here is in English, imperative mood, no strict format beyond that.

## Principles

These are what reviews come back to, so they are worth knowing up front.

**Never invent a number.** If the Coolify API cannot provide something, the UI shows `—`
and a degraded note explains why — on hover, and in `notes` on `/app/overview`. An estimate
that looks like a measurement is the one bug this project refuses to ship. Two KPIs from the
original design were *replaced* rather than faked, for exactly this reason.

**An empty value should say which emptiness it is.** "No collector is configured" and "the
agent stopped answering" are different facts, and three identical em dashes erase the
difference. `ServerMetrics.source` is the model for this.

**Comments explain why.** A comment that restates the code gets removed; one that records a
trap, a measurement, or an approach that was tried and rejected is the most valuable line in
the file.

**Respect the rate-limit budget.** Coolify allows 200 req/min *per user*. Anything that adds
upstream calls should say what it costs, and — where it makes sense — stop when no browser is
connected. The accounting lives in
[docs/roadmap.md](docs/roadmap.md#appendix-b--the-rate-limit-budget) and is expected to stay
accurate.

**The browser never talks to Coolify.** The token stays in the BFF. The front end posts
intents; the server translates them.

## Style

No formatter or linter is configured, on purpose — match the file you are editing. In
practice: two-space indent, no semicolons, single quotes, lines wrapping around 110
characters, and TypeScript with `strict` on (both projects type-check with
`noUnusedLocals` and `noUnusedParameters`).

## Reporting a security issue

Please do not open a public issue — see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
