# coolify-dashboard

Le mockup `divers/coolify-dashboard.html` reconstruit comme une vraie app React —
même design au pixel, mêmes interactions, données isolées derrière une interface
`Dashboard`. Un BFF (Hono) s'intercale entre le navigateur et l'API Coolify.

```bash
npm install
npm run dev      # front : http://localhost:5180  ·  BFF : http://127.0.0.1:8787
                 # proxy Vite : /app → 8787  (GET /app/health)
npm run build
```

Aujourd'hui le front tourne toujours sur le mock. Le BFF n'expose que `/app/health`.

## Structure

```
src/                  front React (existant)
├── styles/           tokens.css · base.css · layout.css
├── data/
│   ├── types.ts      DataSource + réexport du modèle Dashboard
│   ├── mock.ts       données du mockup
│   ├── coolify.ts    adaptateur live (squelette → BFF, phase 1)
│   └── index.ts      seul point de bascule mock ↔ live
├── hooks/
└── components/
shared/               types partagés front / BFF
├── dashboard.ts      modèle Dashboard
├── coolify-api.ts    types de l'API Coolify (écrits à la main)
└── bff.ts            contrat `/app/*`
server/               BFF Hono (port 8787)
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

## Brancher les données live

Pas encore : phase 1 réécrira `src/data/coolify.ts` pour appeler `GET /app/overview`.
Aucun composant à toucher : ils ne voient jamais que le type `Dashboard`.

## Fonctionnalités (identiques au mockup)

- Rail avec tooltips retardés 450 ms, instantanés tant que le rail est « warm »
- Sélecteur d'environnement segmenté, thumb qui glisse (et se replace sans animation au resize)
- Bouton Deploy : morph idle → Deploying → Deployed → idle, largeur animée
- Palette de commandes ⌘K : filtre, ↑↓, ↵, esc, sélection à la souris, focus rendu au chip Search
- Bandeau de trafic edge : sparkline convoyeur, un échantillon / 1200 ms
- KPIs avec tracé animé des sparklines
- Déploiement en cours : chrono, ticker de logs en fondu-flou, barre de progression, **hold-to-cancel** (1,4 s)
- Fleet : jauges CPU/MEM/DSK qui dérivent toutes les 2 s, seuil warn à 80 %
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
