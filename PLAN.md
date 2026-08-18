# Plan — brancher le dashboard sur Coolify et le rendre « plugable »

> Basé sur l'analyse du code source Coolify **v4.3.9** (`upstream/coolify`, branche `main`) et de la
> doc officielle (`upstream/coolify-docs`). Instance cible : **v4.3.2**. Les chemins de fichiers
> Coolify cités sont relatifs à `upstream/coolify/`.

---

## 1. État des lieux

**Le dashboard** est déjà bien architecturé pour ce travail : tous les composants consomment un
unique type `Dashboard` via l'interface `DataSource` ([src/data/types.ts](src/data/types.ts)), avec
un seul point de bascule mock → live ([src/data/index.ts](src/data/index.ts)) et un squelette
d'adaptateur ([src/data/coolify.ts](src/data/coolify.ts)). Aucun composant à toucher pour passer en
données réelles — c'est la couche données qui porte tout le chantier.

**L'API Coolify** (`/api/v1`, Sanctum Bearer token) couvre l'essentiel de ce que l'UI affiche, avec
quatre découvertes structurantes issues de l'analyse du code :

1. **CORS est ouvert** (`config/cors.php` : `allowed_origins: ['*']`, `paths: ['api/*']`) — un
   navigateur peut appeler l'API REST directement. Mais ça ne rend PAS le mode « direct browser »
   viable : le token (longue durée, non lié à une origine) serait exposé dans le client, les
   headers de rate-limit ne sont pas lisibles cross-origin (`exposed_headers: []`), et le websocket
   est inaccessible (point 3).
2. **Pas d'endpoint REST pour les métriques CPU/RAM** : les charts de Coolify passent par des
   composants Livewire qui font du SSH + `docker exec curl` vers **Sentinel** (agent sur chaque
   serveur, port local 8888) — voir `app/Traits/HasMetrics.php`. L'API n'expose que la config
   Sentinel (`GET/PATCH /api/v1/servers/{uuid}/sentinel`).
3. **Pas de temps réel exploitable de l'extérieur** : `POST /broadcasting/auth` (auth des canaux
   Soketi) est en middleware `web` (session + CSRF, pas Bearer) et hors des chemins CORS. Et de
   toute façon **aucun événement de progression de déploiement n'est broadcasté** — l'UI Coolify
   elle-même fait du polling Livewire à 2 s. Le mécanisme « push » officiel, ce sont les
   **webhooks sortants** (canal Webhook des notifications).
4. **Les logs de déploiement** sont un champ `logs` sur l'objet deployment : une **string JSON à
   re-parser** (`Array<{command, output, type, timestamp, hidden, batch, order}>`), visible
   uniquement avec la permission `read:sensitive` **et** un rôle admin/owner dans la team.

**« Plugable » — décision de cadrage.** Coolify n'a **aucun système de plugin** : UI monolithique
Livewire 3, pas de hooks, pas de slots (`routes/web.php` mappe directement vers des composants
Livewire). Les surfaces d'intégration officielles sont l'API REST, le serveur MCP (lecture seule)
et les webhooks sortants. Le « vrai truc plugable » réaliste et pérenne, c'est donc une
**application compagnon** : un conteneur autonome qu'on déploie sur son propre Coolify en
one-click, configuré par variables d'environnement (`COOLIFY_URL`, `COOLIFY_TOKEN`), qui parle à
l'API. Un fork/patch de Coolify est à réserver aux contributions upstream ciblées (cf. métriques,
phase 5).

---

## 2. Architecture cible

Un **BFF** (backend-for-frontend) minimal entre le front React et Coolify. Il est nécessaire pour :
garder le token côté serveur, agréger les ~10 appels API en un seul `/overview` (rate limit
200 req/min **partagé par utilisateur**, tous tokens confondus), recevoir les webhooks sortants de
Coolify, pousser du **SSE** au navigateur, et conserver un petit historique (deltas des KPIs,
uptime) que l'API ne fournit pas.

```
┌─────────────┐   SSE + JSON    ┌──────────────────────────┐   Bearer token   ┌────────────────┐
│  React SPA   │ ◄────────────── │  BFF (Hono/Node, TS)     │ ────────────────►│  Coolify API   │
│  (existant)  │  /app/*         │  · agrégateur /overview  │   /api/v1/*      │  (instance)    │
└─────────────┘                 │  · poller adaptatif       │                  └───────┬────────┘
                                │  · cache + SQLite         │    webhooks             │
                                │  · receveur de webhooks   │ ◄───────────────────────┘
                                │  · sert le build statique │   deployment_success, status_changed…
                                └──────────────────────────┘
```

Arborescence cible (le front actuel ne bouge presque pas) :

```
coolify-dashboard/
├── src/                  ← front React (existant)
│   └── data/             ← DataSource ; coolify.ts pointera vers le BFF
├── server/               ← BFF : Hono + TypeScript (nouveau)
│   ├── index.ts          entrée : statique + /app/* + /events (SSE) + /hooks/coolify
│   ├── coolify/          client API typé + mappers → type Dashboard
│   ├── poller.ts         boucle de polling adaptative
│   ├── store.ts          SQLite (better-sqlite3) : snapshots, historique déploiements, uptime
│   └── probes.ts         checks HTTP des fqdn (uptime, expiration TLS) — optionnel
├── shared/               ← types partagés front/BFF (le type Dashboard y migre)
├── Dockerfile            multi-stage : build Vite → runtime Node unique
├── docker-compose.yml    pour le déploiement one-click sur Coolify
└── upstream/             ← clones de référence (gitignorés)
```

Stack BFF : **Hono** sur Node ≥ 20 (léger, TS natif, SSE trivial), `better-sqlite3` pour l'état,
pas d'ORM. En dev : `vite` (front, port 5180) + `tsx watch` (BFF, port 8787) avec proxy Vite
`/app → 8787`. En prod : un seul process Node qui sert aussi le build statique.

---

## 3. Mapping données : UI ↔ API Coolify

Ce que chaque bloc de l'UI consommera réellement. « BFF » = calculé/stocké par le BFF.

| Bloc UI | Champ `Dashboard` | Source réelle |
|---|---|---|
| Topbar | `org` | `GET /api/v1/team` → `name` |
| Topbar | `environments` | Union des noms d'environnements : `GET /projects` puis `GET /projects/{uuid}/environments` (mis en cache long) |
| Topbar | `systemStatus` | Dérivé BFF : tous serveurs `is_reachable` + aucun déploiement `failed` < 1 h + aucun webhook `server_unreachable`/`high_disk_usage` récent |
| KPI 1 | Applications | `GET /applications` (count) ; delta hebdo via snapshots SQLite |
| KPI 2 | Déploiements 24 h + % ok | Historique par app : `GET /deployments/applications/{uuid}?skip&take` → `{count, deployments}`, agrégé et persisté par le BFF |
| KPI 3 | ~~P95 response~~ → **Durée médiane de déploiement** | `finished_at − created_at` sur l'historique (le P95 HTTP n'existe pas dans Coolify core ; possible plus tard via métriques Traefik, phase 7) |
| KPI 4 | ~~Monthly cost~~ → **Sauvegardes 24 h** | `GET /databases` puis `/databases/{uuid}/backups` + `executions` ; le coût réel est possible si serveurs Hetzner via `/api/v1/hetzner/*` (bonus phase 7) |
| Sparklines KPI | `spark` | Séries construites par le BFF depuis ses snapshots |
| Bandeau trafic | `sampleTraffic` | **Pas de source dans Coolify core.** Court terme : remplacer par un ticker d'activité (événements webhooks + déploiements). Long terme : métriques Prometheus de Traefik (phase 7) |
| Deployments | `deployments[]` en cours | `GET /deployments` (ne renvoie **que** `queued` + `in_progress`) |
| Deployments | historique | `GET /deployments/applications/{uuid}?skip&take` |
| Deployments | `logs[]` du déploiement live | `GET /deployments/{uuid}` → `logs` (string JSON → parser, trier par `order`, filtrer `hidden`) — exige token `read:sensitive` + rôle admin |
| Deployments | états | `queued`, `in_progress`, `finished`, `failed`, `cancelled-by-user` → mapper vers `running/success/failed/cancelled` |
| Deploy (bouton) | `triggerDeploy` | `POST /api/v1/deploy` body `{uuid}` (permission `deploy`) ; queue pleine → 429 `Retry-After: 60` |
| Hold-to-cancel | `cancelDeployment` | `POST /deployments/{uuid}/cancel` (seulement `queued`/`in_progress`, sinon 400) |
| Fleet | `servers[]` | `GET /servers` (+ `GET /servers/{uuid}` pour `settings`) ; `reachable` = `is_reachable` |
| Fleet | jauges CPU/MEM | **Sentinel** — pas d'endpoint REST (voir phase 5, trois options) |
| Fleet | DSK | Webhooks `high_disk_usage` + champ serveur ; à défaut « — » |
| Fleet | `pingMs` | Probe TCP du BFF vers l'IP du serveur (optionnel) |
| Fleet | `fleetTotals` | Non exposé par l'API ; via Hetzner si applicable, sinon config statique BFF ou masqué |
| Insights | `insights[]` | Moteur de règles BFF : serveur injoignable, série de déploiements échoués, disque haut (webhook), app en `exited/degraded`, **expiration TLS sondée directement par le BFF sur les fqdn** |
| Applications | `applications[]` | `GET /applications` : `name`, `fqdn`, `status` (`"running:healthy"` → parser), `uuid` |
| Applications | `uptime` | Probes HTTP du BFF sur les fqdn + historique SQLite (Coolify ne fournit pas d'uptime) |
| Applications | toggle auto-deploy | `PATCH /applications/{uuid}` body `{"is_auto_deploy_enabled": bool}` (vérifié dans `ApplicationsController.php:1194`) |
| Schedule | `timeline` | `GET /{applications,services}/{uuid}/scheduled-tasks` + backups planifiés (`GET /databases/{uuid}/backups` → `frequency`) ; parsing cron côté BFF (`cron-parser`) → position % sur 24 h |
| Palette ⌘K | `paletteActions` | Générées depuis les ressources réelles : deploy/restart/stop app (`POST /applications/{uuid}/{start,restart,stop}`), exécuter une tâche (`POST .../scheduled-tasks/{uuid}/execute`), liens de navigation |

---

## 4. Phases

### Phase 0 — Fondations (½ journée)
- Passer le dossier en **monorepo léger** : `shared/` (le type `Dashboard` + types API Coolify),
  `server/` (Hono), scripts `dev` (concurrently), proxy Vite `/app → 8787`. `git init` + premier commit.
- Écrire les **types API Coolify** à la main dans `shared/coolify-api.ts` à partir de
  `openapi.json` (à la racine du repo upstream) — **ne pas générer un client aveuglément** : le
  spec a du drift connu (réponse de `/deployments/applications/{uuid}` fausse, routes absentes,
  `GET /resources` non spécifié).
- Côté instance (checklist annexe A) : activer l'API, créer les tokens.
- ✅ *Fini quand* : `npm run dev` lance front + BFF, `GET /app/health` répond, le front tourne
  toujours sur le mock.

### Phase 1 — Lecture seule : le dashboard affiche du vrai (1–2 jours)
- `server/coolify/client.ts` : fetch typé, Bearer, gestion 401/403/429, **`/version` renvoie du
  texte brut** (pas de `res.json()` là-dessus).
- `server/coolify/mappers.ts` : fonctions **pures** API → `Dashboard` (testables unitairement :
  parsing des `logs`, du `status` `"running:healthy"`, positions cron).
- `GET /app/overview?env=` : agrège applications, serveurs, déploiements, tâches ; cache mémoire
  (TTL par famille : servers 60 s, apps 30 s, deployments 3–10 s adaptatif).
- Snapshots SQLite (1/h) pour les deltas et sparklines des KPIs.
- Ré-écrire `src/data/coolify.ts` → il appelle le BFF (`/app/overview`), plus l'API Coolify.
  Bascule dans `src/data/index.ts`.
- ✅ *Fini quand* : le dashboard affiche les vraies apps/serveurs/déploiements de l'instance,
  KPIs 1-2 réels, zéro appel Coolify depuis le navigateur.

### Phase 2 — Actions (1 jour)
- `POST /app/deploy` → `POST /api/v1/deploy {uuid}` ; `POST /app/deployments/{uuid}/cancel` ;
  `POST /app/applications/{uuid}/autodeploy`.
- Toasts branchés sur les vraies réponses ; erreurs distinguées : 403 « permission manquante /
  rôle insuffisant — voir un admin », 429 « queue pleine, réessai dans 60 s », API désactivée.
- Palette ⌘K : actions réelles (deploy, restart, stop, run task) avec confirmation pour stop.
- ⚠️ `start/stop/restart` : **POST** sur main v4.3.9, la doc dit GET (anciennes versions).
  L'instance est en 4.3.2 → implémenter POST avec fallback GET (détection au premier appel, mémorisée).
- ✅ *Fini quand* : Deploy, hold-to-cancel et toggle auto-deploy agissent réellement sur l'instance.

### Phase 3 — Temps réel (1–2 jours)
- **Polling adaptatif** dans le BFF (c'est ce que fait l'UI Coolify elle-même) : `/deployments`
  toutes les 3 s si un déploiement est actif, sinon 15 s ; `GET /deployments/{uuid}` pour les logs
  du déploiement live à 2–3 s. Budget total < 60 req/min (annexe B).
- **Webhooks entrants** : `POST /app/hooks/coolify` (secret dans l'URL — les payloads ne sont pas
  signés). Configuration sur l'instance via `PATCH /api/v1/notifications/webhook`. Événements
  utiles : `deployment_success/failed`, `status_changed`, `backup_success/failed`,
  `server_reachable/unreachable`, `high_disk_usage`, `task_success/failed`,
  `container_stopped/restarted` → invalidation de cache immédiate + insight éventuel.
- **SSE** `GET /app/events` : le front (hook `useLiveDashboard`) reçoit `overview-changed`,
  `deployment-log`, `toast`. Chrono, ticker de logs et transitions du bouton Deploy passent en réel.
- ✅ *Fini quand* : un déploiement lancé depuis Coolify apparaît < 5 s dans le dashboard, logs qui
  défilent, fin de déploiement notifiée par toast sans refresh.

### Phase 4 — Uptime & insights (1 jour)
- `server/probes.ts` : check HTTP des `fqdn` (60 s, opt-in par app) → uptime % réel + latence
  (peut nourrir un KPI latence honnête) + **expiration des certificats TLS** (poignée de main TLS).
- Moteur de règles insights (chaque règle = fonction pure sur l'état BFF) : serveur injoignable,
  ≥ 2 échecs consécutifs sur une app, disque > seuil, app `exited`, cert < 14 j, backup échoué.
- ✅ *Fini quand* : la colonne insights reflète l'état réel et chaque action mène quelque part.

### Phase 5 — Métriques serveurs (Sentinel) (1–2 jours, en partie hors repo)
Pas d'endpoint REST pour les séries CPU/RAM. Trois options, par ordre de recommandation :
1. **Contribution upstream** (la bonne solution) : PR ajoutant `GET /api/v1/servers/{uuid}/metrics`
   — le trait `HasMetrics` (`app/Traits/HasMetrics.php`) fait déjà tout, il suffit d'un contrôleur
   API qui l'appelle (mêmes garde-fous `read:sensitive`). Bénéficie à tout l'écosystème.
2. **Collecteur SSH dans le BFF** en attendant : reproduire ce que fait Coolify —
   `ssh` → `docker exec coolify-sentinel curl -H "Authorization: Bearer <sentinel_token>"
   http://localhost:8888/api/{cpu,memory}/history?from=…` ; le `sentinel_token` s'obtient via
   `GET /api/v1/servers/{uuid}/sentinel` (token `read:sensitive`). Nécessite la clé SSH du serveur
   montée dans le conteneur BFF (opt-in).
3. **Mode dégradé** (défaut sans SSH ni PR) : jauges remplacées par l'état de santé
   (`status`, heartbeat Sentinel via `sentinel_updated_at`, disque via webhooks) — l'UI reste
   honnête au lieu d'inventer des pourcentages.
- Activer Sentinel par serveur : `PATCH /api/v1/servers/{uuid}/sentinel`
  `{"is_sentinel_enabled": true, "is_metrics_enabled": true}`.
- ✅ *Fini quand* : les jauges Fleet affichent des données réelles (option 1 ou 2) OU le mode
  dégradé est propre (option 3), au choix documenté.

### Phase 6 — Navigation & pages (2–3 jours)
Le README l'annonce : « le rail ne navigue pas — premier vrai ajout à faire. »
- `react-router` (routes : `/`, `/applications`, `/applications/:uuid`, `/deployments`,
  `/servers/:uuid`, `/schedule`), rail actif via `aria-current` (déjà stylé).
- Page app : logs runtime (`GET /applications/{uuid}/logs`, réponse `{logs: "<string>"}`,
  400 si conteneur arrêté), env vars (`GET .../envs` — masquées sans `read:sensitive`), historique
  de déploiements paginé (`skip`/`take`), rollback (`GET .../rollback-images` + `POST .../rollback`).
- Sélecteur d'environnement : filtre transversal par nom d'environnement (Production/Staging…)
  sur toutes les ressources, mappé depuis `environment_id`.
- ✅ *Fini quand* : chaque entrée du rail mène à une page réelle et la palette navigue.

### Phase 7 — Packaging « plugable » (1 jour + bonus)
- **Dockerfile** multi-stage : `vite build` → image Node slim unique (BFF sert `dist/`),
  `HEALTHCHECK` sur `/app/health`, image < 150 Mo.
- **docker-compose.yml** avec variables : `COOLIFY_URL`, `COOLIFY_TOKEN` (requis),
  `DASHBOARD_PASSWORD` (auth du dashboard : session cookie signée — le token Coolify n'atteint
  jamais le navigateur), `WEBHOOK_SECRET`, `PROBES_ENABLED`, volume `/data` pour SQLite.
- **Déploiement sur Coolify lui-même** : app Docker Compose (repo public ou registre d'images),
  domaine + HTTPS via le proxy Coolify. README d'installation en 5 étapes, incluant la
  configuration du webhook sortant vers `https://<dashboard>/app/hooks/coolify?secret=…`.
- Setup guidé au premier lancement : page `/setup` qui teste le token (`/api/v1/version`,
  `/api/v1/team`), vérifie les permissions et liste ce qui manque.
- **Bonus écosystème** : proposer le dashboard comme **service template** Coolify
  (`templates/compose/` upstream) pour un vrai one-click depuis l'UI de Coolify — c'est le
  maximum de « plugable » que permet l'architecture de Coolify aujourd'hui.
- **Bonus trafic** : activer les métriques Prometheus de Traefik via
  `PUT /api/v1/servers/{uuid}/proxy/configuration` et les scraper depuis le BFF → vrai bandeau de
  trafic edge et vrai P95.
- ✅ *Fini quand* : `docker compose up` avec 3 variables suffit ; déployé et accessible via une
  URL servie par l'instance Coolify du projet.

---

## Annexe A — Checklist côté instance Coolify

1. **Activer l'API** : Settings → Advanced → API Access (`is_api_enabled` est **false par défaut**
   sur self-hosted).
2. **Tokens** (Security → API Tokens, affichés une seule fois, liés à la team active) — deux tokens :
   - `dashboard-read` : `read` + `read:sensitive` (logs de déploiement, valeurs env) ;
   - `dashboard-actions` : `deploy` + `write` (deploy, cancel, toggle auto-deploy, run task).
   Le compte créateur doit être **admin/owner** de la team, sinon 403 systématique sur les
   abilities élevées (`EnsureTokenBelongsToCurrentTeamMember`).
3. **Rate limit** : `API_RATE_LIMIT` (défaut 200/min, **par utilisateur** — créer les tokens depuis
   un compte machine dédié pour isoler le budget du dashboard).
4. **IP allowlist** (Settings → Advanced) : y mettre l'IP du serveur qui héberge le BFF, ou `0.0.0.0`.
5. **Webhook sortant** : `PATCH /api/v1/notifications/webhook` → URL du BFF, activer les événements
   deployment/status/backup/server.
6. **Sentinel** (par serveur, si phase 5) : `PATCH /api/v1/servers/{uuid}/sentinel`.

## Annexe B — Budget rate-limit (200 req/min)

| Poller | Cadence repos | Cadence active | req/min max |
|---|---|---|---|
| `/deployments` (running) | 15 s | 3 s | 20 |
| `/deployments/{uuid}` (logs live) | — | 2,5 s | 24 |
| `/applications` | 30 s | 30 s | 2 |
| `/servers` + sentinel | 60 s | 60 s | 2–4 |
| Historique déploiements (incrémental) | 5 min | 1 min | ~5 |
| Tâches planifiées + backups | 5 min | 5 min | ~3 |
| **Total** | | | **< 60** ✅ |

Le BFF sert N onglets/navigateurs avec ce budget constant — c'est l'argument massue contre le
mode « browser direct » (budget × clients, et headers `X-RateLimit-*` invisibles en CORS).

## Annexe C — Pièges vérifiés dans le code (à ne pas redécouvrir)

- `logs` d'un déploiement = **string JSON** (pas un tableau) → `JSON.parse`, trier par `order`,
  filtrer `hidden`, `type` ∈ `stdout|stderr`. Déjà expurgés (valeurs secrètes → `REDACTED`).
- `GET /deployments` ne renvoie **que** `queued`/`in_progress` ; l'historique est par application.
- Pas de `started_at` sur un déploiement : durée = `finished_at − created_at` (inclut la file).
- `GET /api/v1/version` et `/api/health` répondent en **texte brut**.
- Écritures : `Content-Type: application/json` + body JSON non vide obligatoires, sinon 400.
- Réponses : `serializeApiResponse` réordonne les clés — ne jamais dépendre de l'ordre.
- OpenAPI (`openapi.json` racine du repo) a du **drift** : vérifier contre `routes/api.php`.
- Webhooks sortants **non signés** → secret dans l'URL + tolérance aux doublons (déduplication
  par `deployment_uuid` + event).
- MCP (`/mcp`, Streamable HTTP, même Bearer) : lecture seule, inutile pour le dashboard mais
  pratique pour débugger pendant le dev (déjà branché dans cette session Claude).
