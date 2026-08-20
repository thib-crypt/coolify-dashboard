## What this changes

<!-- And why. If it fixes an issue, "Fixes #123". -->

## How it was verified

<!-- Against a real Coolify instance, the mock, or the test suite? Which paths? -->

- [ ] `npm run typecheck && npm test && npm run build` passes
- [ ] Tests cover the new behaviour (or the bug that was fixed)
- [ ] Docs updated — `.env.example` and `docs/configuration.md` for a new variable,
      `docs/coolify-api-notes.md` for a newly found Coolify quirk
- [ ] Nothing new is estimated: anything the API cannot provide renders as `—` with a
      degraded note saying why
- [ ] Upstream cost accounted for, if this adds Coolify calls
      (`docs/roadmap.md`, appendix B)
