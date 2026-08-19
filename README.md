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
npm test                # mappers, cache, client, actions, hub, poller, webhooks (node:test)
npm run typecheck
npm run build
```

**Le dashboard affiche les données réelles de l'instance, agit dessus et se met
à jour tout seul** (phases 1 à 3 faites). Sans `.env`, le BFF répond 503 et le
front affiche l'erreur avec la marche à suivre. Pour travailler l'UI sans
instance : `npm run dev:mock`.

## Structure

```
src/                  front React (existant)
├── styles/           tokens.css · base.css · layout.css
├── data/
│   ├── types.ts      DataSource + réexport du modèle Dashboard
│   ├── mock.ts       données du mockup
│   ├── coolify.ts    adaptateur live → GET /app/overview + SSE /app/events
│   └── index.ts      seul point de bascule mock ↔ live
├── hooks/
│   └── useLiveDashboard.ts   payload + canal live + polling de secours
└── components/
shared/               types partagés front / BFF
├── dashboard.ts      modèle Dashboard
├── coolify-api.ts    types de l'API Coolify (écrits à la main)
└── bff.ts            contrat `/app/*`
server/               BFF Hono (port 8787)
├── index.ts          routes : /app/health · /app/overview · /app/events (SSE)
│                     · /app/hooks/coolify · les actions (POST)
├── actions.ts        écritures : lit ce que Coolify a *vraiment* fait, purge le cache
├── events.ts         hub SSE : diffusion + déduplication poller ↔ webhooks
├── poller.ts         boucle adaptative 2,5 s / 4 s, à l'arrêt si personne n'écoute
├── hooks.ts          webhooks entrants : secret constant-time, payload → effets
├── config.ts         COOLIFY_URL / COOLIFY_TOKEN / BFF_PORT / DATA_DIR / WEBHOOK_SECRET
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
4. **Webhook sortant** (optionnel, phase 3) : mettre un `WEBHOOK_SECRET` dans `.env`, puis
   ```
   PATCH /api/v1/notifications/webhook
   { "webhook_enabled": true,
     "webhook_url": "https://<dashboard>/app/hooks/coolify?secret=<WEBHOOK_SECRET>",
     "deployment_success_webhook_notifications": true,
     "deployment_failure_webhook_notifications": true,
     "status_change_webhook_notifications": true,
     "server_unreachable_webhook_notifications": true,
     "backup_failure_webhook_notifications": true }
   ```
   Coolify **refuse** une URL loopback ou privée (`SafeWebhookUrl`) : le BFF doit être joignable
   publiquement. Sans webhook, le dashboard reste à jour par polling, juste un peu plus tard.
5. Plus tard : IP allowlist du BFF, Sentinel — détaillés dans `PLAN.md` (annexe A).

## Données live — ce qui est réel, ce qui ne l'est pas

`src/data/coolify.ts` appelle `GET /app/overview?env=` sur le BFF et écoute
`GET /app/events`. **Le navigateur ne contacte jamais Coolify** : le token reste
côté serveur, et un seul BFF sert n'importe quel nombre d'onglets dans le budget
de 200 req/min *par utilisateur* (20 requêtes simultanées ⇒ 1 appel amont ;
< 35 appels/min en régime établi, 0 quand aucun onglet n'est ouvert).

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

## Temps réel (phase 3)

Le dashboard ne se rafraîchit plus à la main. Le BFF pousse en **SSE** sur
`GET /app/events`, alimenté par deux sources qui se recouvrent volontairement :

| Source | Ce qu'elle voit | Latence |
|---|---|---|
| Poller `/deployments` | déploiements qui **démarrent**, logs qui s'allongent, déploiements qui finissent | 2,5 s en build, 4 s au repos |
| Webhooks entrants | fins de déploiement, serveur injoignable, disque plein, backup/tâche en échec | immédiat |

Les webhooks sont le chemin rapide **quand ils sont configurés** ; le poller est
le plancher quand ils ne le sont pas. Aucun des deux n'est indispensable :
si le flux SSE est coupé (proxy qui bufferise, filtre d'entreprise, laptop en
veille), le front retombe sur un fetch toutes les 10 s au lieu de 60 s.

Événements poussés — `hello` (+ ce que le canal ne peut pas livrer),
`overview-changed` (refetch de `/app/overview`, coalescé à 250 ms côté front),
`deployment-log` (nouvelles lignes, avec leur index absolu), `deployment-finished`
et `toast`.

Ce qui devient réel dans l'UI :

- le **ticker de logs** défile ligne à ligne sur le vrai log du build, au lieu de
  tourner en boucle sur un tableau figé (il tient la dernière ligne quand il a
  rattrapé le flux, au lieu de reboucler) ;
- le **chrono** est ancré sur un instant de départ, pas sur un compteur de ticks —
  un onglet en arrière-plan voit ses timers throttlés et perdait des secondes ;
- le **bouton Deploy** reste sur « Deploying » jusqu'à la **fin du build**, plus
  seulement jusqu'à la réponse HTTP (quelques centaines de ms sur un build de
  plusieurs minutes) ;
- la **fin d'un déploiement** arrive en toast, sans refresh.

### Ce que ça coûte, et pourquoi c'est moins que prévu

Le poller **s'arrête quand plus aucun navigateur n'est connecté** : au repos, sans
onglet ouvert, le BFF ne fait aucune requête. Et il ne poll que `/deployments` :
cette liste **porte déjà les `logs`** quand le token a `read:sensitive`, donc
poller en plus chaque déploiement en cours doublerait le coût sans rien apprendre.
`GET /deployments/{uuid}` ne sert plus qu'à lire le statut terminal d'un
déploiement qui vient de quitter la liste — un appel par fin de build.

Résultat : **< 35 req/min** au pire contre les 60 budgétés (annexe B de `PLAN.md`),
pour N onglets. Ce budget a été dépensé là où il sert : la cadence au repos est
passée de 15 s à 4 s, parce que **Coolify n'émet aucun webhook au *démarrage* d'un
déploiement** — les 20 événements sortants couvrent succès, échec, statut, backups,
tâches et serveurs, jamais le début d'un build. Cette cadence *est* donc la latence
de détection d'un déploiement lancé depuis l'UI Coolify. Mesuré bout en bout :
**3,6 s**.

### Webhooks : trois contraintes vérifiées dans le code Coolify

- **Les payloads ne sont pas signés.** `SendWebhookJob` poste le corps, point : pas
  de HMAC, pas d'horodatage, pas d'identifiant de livraison. L'authentification est
  donc un secret dans l'URL, comparé en temps constant (SHA-256 des deux côtés, pour
  que `timingSafeEqual` ne jette pas — et ne fuite pas la longueur — sur une taille
  différente). Sans `WEBHOOK_SECRET`, la route répond 503 plutôt que d'accepter
  n'importe qui.
- **Coolify retente 5 fois** (backoff 10 s) et une retentative est byte-identique à
  un nouvel événement. Chaque annonce porte donc une clé de déduplication
  (`deployment-finished:<uuid>`, `server_unreachable:<serveur>`, …) valable 2 min.
  La même clé sert au poller : la fin d'un déploiement est annoncée **une fois**,
  par celui des deux qui la voit en premier.
- **Le coup de pouce de rafraîchissement est hors déduplication.** Une retentative
  ne doit rien republier du tout : sinon les cinq livraisons coûteraient cinq
  `/app/overview` par onglet ouvert. La réponse le dit (`accepted: false`).

Coolify refuse par ailleurs les URLs de webhook loopback / lien-local / privées
(`SafeWebhookUrl`), sauf allowlist de l'opérateur : en local, le polling est le
seul canal — ce qui est exactement le mode dégradé prévu.

`GET /app/health` rend compte de tout ça :

```json
"live": { "subscribers": 1, "poller": "active", "webhooks": "ready",
          "lastWebhookAt": "2026-08-19T09:50:11.276Z" }
```

## Fonctionnalités (identiques au mockup)

- Rail avec tooltips retardés 450 ms, instantanés tant que le rail est « warm »
- Sélecteur d'environnement segmenté, thumb qui glisse (et se replace sans animation au resize)
- Bouton Deploy : morph idle → Deploying → Deployed → idle, largeur animée
- Palette de commandes ⌘K : filtre, ↑↓, ↵, esc, sélection à la souris, focus rendu au chip Search
- Bandeau de trafic edge : sparkline convoyeur, un échantillon / 1200 ms
- KPIs avec tracé animé des sparklines
- Déploiement en cours : chrono, ticker de logs en fondu-flou, barre de progression, **hold-to-cancel** (1,4 s)
  — chrono et logs sont réels depuis la phase 3, le ticker ne boucle plus quand le flux est ouvert
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
