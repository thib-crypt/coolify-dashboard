# Templates

## `coolify/coolify-dashboard.yaml`

A [Coolify service template](https://coolify.io/docs/knowledge-base/add-a-service): the
closest thing to a one-click install this architecture allows, since Coolify has no plugin
system and the dashboard is a companion application rather than an extension.

Coolify generates the domain, the dashboard password and the webhook secret from it, and
asks you only for the two things it cannot know: the URL of the instance to watch and an API
token for it.

### Using it today

Coolify's built-in service list is compiled from its own repository, so until this template
is merged upstream it is used by hand — which takes about as long:

1. **New Resource → Docker Compose Empty**, on the server you want it to run on.
2. Paste the contents of [`coolify/coolify-dashboard.yaml`](coolify/coolify-dashboard.yaml).
3. **Save.** Coolify parses the file, generates `SERVICE_PASSWORD_DASHBOARD` and
   `SERVICE_PASSWORD_WEBHOOK`, and lists `COOLIFY_URL` and `COOLIFY_TOKEN` as empty for you
   to fill — see [docs/coolify-setup.md](../docs/coolify-setup.md) for the token.
4. **Attach a domain** to port `8787`, and deploy.
5. Sign in with the generated `DASHBOARD_PASSWORD`, visible in the resource's environment
   variables.
6. Optional, and worth it: copy `WEBHOOK_SECRET` into
   `Settings → Notifications → Webhook` as
   `https://<your-domain>/app/hooks/coolify?secret=<that value>`. That turns a few seconds
   of polling latency into an instant push.

> **`COOLIFY_URL` is the instance you want to watch, and it must be set.** A resource
> deployed by Coolify that leaves it empty receives Coolify's *own* injected `COOLIFY_URL`,
> which is that resource's own domain — a dashboard pointed at itself. The setup check
> recognises this exact case and says so.

### Submitting it upstream

Coolify's templates live in `templates/compose/` in
[coollabsio/coolify](https://github.com/coollabsio/coolify), one YAML file per service, with
the metadata in the leading comments (`documentation`, `slogan`, `category`, `tags`, `logo`,
`port`). This file is already in that shape.

Two things it needs before a pull request:

- **a logo** at `public/svgs/coolify-dashboard.svg` in that repository — the header currently
  points at Coolify's own `svgs/coolify.svg`, which is a placeholder;
- **a published image people can pull**, which
  [`ghcr.io/thib-crypt/coolify-dashboard`](https://github.com/thib-crypt/coolify-dashboard/pkgs/container/coolify-dashboard)
  now is — the package has to be public for the template to work for anyone else.
