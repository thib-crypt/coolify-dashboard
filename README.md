# coolify-dashboard

Le mockup `divers/coolify-dashboard.html` reconstruit comme une vraie app React —
même design au pixel, mêmes interactions, données isolées derrière une interface
`Dashboard`. Un BFF (Hono) s'intercale entre le navigateur et l'API Coolify.

```bash
npm install
cp .env.example .env    # y mettre COOLIFY_URL + COOLIFY_TOKEN
npm run dev             # front : http://localhost:5180 · BFF : http://127.0.0.1:8787
                        # proxy Vite : /app → 8787
npm run dev:mock        # front seul, sur les données du mock (sans instance)
npm test                # mappers, cache, client, actions (node:test)
npm run typecheck
npm run build
```

**Le dashboard affiche les données réelles de l'instance et agit dessus**
(phases 1 et 2 faites). Sans `.env`, le BFF répond 503 et le front affiche
l'erreur avec la marche à suivre. Pour travailler l'UI sans instance :
`npm run dev:mock`.

## Structure

```
src/                  front React (existant)
├── styles/           tokens.css · base.css · layout.css
├── data/
│   ├── types.ts      DataSource + réexport du modèle Dashboard
│   ├── mock.ts       données du mockup
│   ├── coolify.ts    adaptateur live → GET /app/overview
│   └── index.ts      seul point de bascule mock ↔ live
├── hooks/
└── components/
shared/               types partagés front / BFF
├── dashboard.ts      modèle Dashboard
├── coolify-api.ts    types de l'API Coolify (écrits à la main)
└── bff.ts            contrat `/app/*`
server/               BFF Hono (port 8787)
├── index.ts          routes : /app/health · /app/overview · les actions (POST)
├── actions.ts        écritures : lit ce que Coolify a *vraiment* fait, purge le cache
├── config.ts         COOLIFY_URL / COOLIFY_TOKEN / BFF_PORT / DATA_DIR
├── cache.ts          cache TTL par famille : single-flight + valeur périmée si l'amont tombe
├── store.ts          snapshots horaires (node:sqlite) → deltas et sparklines des KPIs
├── overview.ts       agrégateur : ~10 endpoints Coolify → un seul `Dashboard`
└── coolify/
    ├── client.ts     fetch typé, Bearer, 400/401/403/429, /version en texte brut
    └── mappers.ts    fonctions **pures** API → Dashboard (+ mappers.test.ts)
```

Le CSS est repris **verbatim** du mockup, juste découpé par composant. Les media
queries vivent dans le fichier de leur règle de base, donc l'ordre d'import ne
peut pas casser le responsive.

## Checklist instance Coolify

À faire sur l'instance (v4.3.2) avant de brancher le live :

1. **Activer l'API** : Settings → Advanced → API Access (`is_api_enabled` est false par défaut en self-hosted).
2. **Tokens** (Security → API Tokens, affichés une seule fois, liés à la team active) :
   - `dashboard-read` : `read` + `read:sensitive` (logs de déploiement, valeurs env) ;
   - `dashboard-actions` : `deploy` + `write` (deploy, cancel, toggle auto-deploy, run task).
   Le compte créateur doit être **admin/owner** de la team.
3. Copier l'URL de l'instance et un token dans `.env` (voir `.env.example`).
4. Plus tard : IP allowlist du BFF, webhook sortant, Sentinel — détaillés dans `PLAN.md` (annexe A).

## Données live — ce qui est réel, ce qui ne l'est pas

`src/data/coolify.ts` appelle `GET /app/overview?env=` sur le BFF. **Le navigateur
ne contacte jamais Coolify** : le token reste côté serveur, et un seul BFF sert
n'importe quel nombre d'onglets dans le budget de 200 req/min *par utilisateur*
(20 requêtes simultanées ⇒ 1 appel amont ; ~14 appels/min en régime établi).

Réel dès maintenant : organisation, environnements, applications (nom, domaine,
statut, auto-deploy), serveurs et joignabilité, déploiements en cours et
historique 24 h, logs du déploiement live (token `read:sensitive`), tâches
planifiées et sauvegardes sur la timeline, les 4 KPIs, les insights.

Affiché « — » faute de source dans l'API Coolify, et daté dans `PLAN.md` :

| Ce qui manque | Pourquoi | Phase |
|---|---|---|
| Jauges CPU / MEM / DSK | Aucun endpoint REST : Sentinel passe par SSH | 5 |
| Uptime des applications | Coolify n'en garde pas la trace | 4 |
| Latence (ping) des serveurs | Sonde à écrire côté BFF | 4 |
| Bandeau de trafic edge | Rien dans Coolify core (métriques Traefik) | 7 |

Deux KPIs du mockup n'ont pas de source et ont été remplacés, pas inventés :
P95 → **durée médiane de déploiement**, coût mensuel → **sauvegardes 24 h**.

## Actions (phase 2)

Le front n'envoie jamais d'uuid Coolify à Coolify : il poste sur le BFF, qui
traduit, purge son cache et renvoie un `ActionResponse` — `outcome` +
le message de Coolify, affiché tel quel dans le toast.

| Geste dans l'UI | Route du BFF | Appel Coolify |
|---|---|---|
| Bouton Deploy, palette « Deploy … » | `POST /app/deploy` `{uuid}` | `POST /deploy` |
| Hold-to-cancel (1,4 s) | `POST /app/deployments/{uuid}/cancel` | `POST /deployments/{uuid}/cancel` |
| Toggle auto deploy | `POST /app/applications/{uuid}/autodeploy` `{enabled}` | `PATCH /applications/{uuid}` |
| Palette « Restart / Stop … » | `POST /app/applications/{uuid}/{start,restart,stop}` | idem, en POST |
| Palette « Run … » | `POST /app/{applications,services}/{uuid}/tasks/{task}/run` | `POST …/scheduled-tasks/{task}/execute` |

`outcome` vaut `queued` (un déploiement existe, son uuid est renvoyé), `done`
(appliqué tout de suite : stop, toggle) ou `skipped` — **Coolify répond 200 même
quand il n'a rien fait**, et le dashboard ne fête pas un non-événement.

Chaque écriture invalide ce que les lectures avaient mis en cache (les
déploiements après un deploy, le détail de l'application après un toggle) :
sans ça le clic resterait invisible jusqu'à 5 min.

Erreurs distinguées jusqu'au toast, avec la marche à suivre : `forbidden`
(ability manquante ou rôle insuffisant dans la team), `queue_full` (file pleine,
`Retry-After: 60`), `rate_limited`, `invalid_state` (annuler un déploiement déjà
terminé), `not_found`, `not_configured`.

Les commandes de la palette voyagent typées (`PaletteCommand`), pas en chaînes à
re-parser, et `Stop` demande une confirmation dans la palette elle-même.

### Pièges de l'API vérifiés dans le code source

- Un token invalide renvoie **400 « Invalid token. »**, pas 401.
- `GET /applications` **masque `id`** et n'inclut pas `settings` : l'auto-deploy
  demande `GET /applications/{uuid}`, et les déploiements ne peuvent se rattacher
  à une app que par `application_name`.
- `finished_at` arrive parfois en `2026-08-17 12:02:06` (sans fuseau) alors que
  Coolify stocke de l'UTC — parsé comme local, ça décale toutes les durées.
- `logs` est une **chaîne JSON**, visible seulement avec `read:sensitive` + rôle admin.
- `GET /deployments` ne renvoie que `queued`/`in_progress`.
- `GET /api/v1/version` répond en **texte brut**.
- **200 ≠ déployé** : un deploy ignoré (« Deployment already queued for this
  commit. ») et un deploy refusé (« Unauthorized to deploy this application. »)
  arrivent tous les deux en 200 ; seul le message les distingue. Pire, sur un
  deploy ignoré le `deployment_uuid` renvoyé est un id fraîchement généré qui ne
  correspond à aucun déploiement — le BFF le jette.
- `start` / `stop` / `restart` sont en **POST** (la doc dit GET ; les instances
  actuelles répondent 405 « This endpoint has changed to a POST request. »).
  Le client tente POST, retombe une fois sur GET pour les vieilles instances, et
  mémorise le verbe qui marche.
- Une écriture sans `Content-Type: application/json` **et** corps JSON non vide
  est refusée en 400.
- La file de déploiement pleine et le rate limiter répondent tous les deux 429 :
  c'est le message qui tranche.

## Fonctionnalités (identiques au mockup)

- Rail avec tooltips retardés 450 ms, instantanés tant que le rail est « warm »
- Sélecteur d'environnement segmenté, thumb qui glisse (et se replace sans animation au resize)
- Bouton Deploy : morph idle → Deploying → Deployed → idle, largeur animée
- Palette de commandes ⌘K : filtre, ↑↓, ↵, esc, sélection à la souris, focus rendu au chip Search
- Bandeau de trafic edge : sparkline convoyeur, un échantillon / 1200 ms
- KPIs avec tracé animé des sparklines
- Déploiement en cours : chrono, ticker de logs en fondu-flou, barre de progression, **hold-to-cancel** (1,4 s)
- Fleet : jauges CPU/MEM/DSK (seuil warn à 80 %) — rails vides en live, faute de source
- Insights, Applications (toggles auto-deploy), timeline des tâches planifiées
- Toasts, animations d'entrée en cascade, `prefers-reduced-motion`, breakpoints 1020 / 680 px

## Deux écarts assumés par rapport au mockup

- **Le rail ne navigue pas.** Il n'y a qu'une page dans le mockup, `aria-current`
  reste sur Overview. C'est le premier vrai ajout à faire.
- **Le crossfade du bouton Deploy ne s'affiche pas.** Le mockup déclare
  `.deploy .face[hidden]{display:flex;opacity:0;filter:blur(3px)}` mais la règle
  générique `[hidden]{display:none !important}`, déclarée après, gagne. Les faces
  se remplacent donc sèchement. Reproduit tel quel. Pour retrouver le fondu voulu :
  ajouter `!important` au `display:flex` dans `components/Topbar.css`.
