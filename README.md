# SAV Tracker — BestMobilier

Dashboard SAV (React + Vite + Tailwind + Supabase) consolidant les tickets eDesk
(site + marketplaces) : priorisation, notation par canal, taux de SAV par référence
produit.

Repo séparé de `marketplace-tracker`, même projet Supabase (tables préfixées `sav_`),
même logique que `dashboard-veille` : Vercel indépendant pour l'instant, à
rediffuser plus tard dans `marketplace-tracker` (comme la page Veille digitale
concurrentielle).

## ⚠️ État du schéma eDesk — à vérifier au premier run réel

Le schéma exact des réponses JSON de l'API eDesk (developers.edesk.com) n'a pas pu
être vérifié en détail sans jeton réel — la documentation ne montre pas les schémas
de réponse en statique (rendu JS). `sync/edesk_sync.js` :
- essaie plusieurs noms de champs plausibles en snake_case (déduits des noms de
  paramètres de filtre documentés : `created_at`, `last_updated_at`,
  `owner_user_id`, `contact_id`, `channel_id`, `sales_order_id`...)
- stocke systématiquement le payload brut en colonne `raw JSONB` sur chaque table

**Avant de laisser tourner le sync automatique**, lancer un `DRY_RUN=true` et
comparer `raw` à quelques lignes attendues (voir section Sync ci-dessous). Aucune
perte de données dans l'intervalle — juste des colonnes extraites potentiellement
vides à corriger dans `sync/edesk_sync.js` (fonctions `extract*`).

Le jeton eDesk **expire par défaut à 90 jours** — à régénérer périodiquement
(dashboard.edesk.com/api-token) et à mettre à jour dans le secret GitHub
`EDESK_API_TOKEN`.

## Setup local

```bash
npm install
cp .env.example .env.local
# édite .env.local avec VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm run dev
```

Ouvre http://localhost:5174.

## Base de données

1. Exécuter `migrations/20260702_sav_tracker_init.sql` dans le Supabase SQL Editor
   du **même projet** que marketplace-tracker (tables `sav_*`, aucun impact sur
   l'existant).
2. La vue `sav_product_stats` (taux de SAV par référence) joint `sav_tickets`
   (déballé sur `order_refs`) avec `ps_sales_daily` (marketplace-tracker) — même
   base, pas de connexion supplémentaire nécessaire.

## Sync eDesk → Supabase

```bash
cd sync
cp ../.env.example .env   # remplir EDESK_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
node edesk_sync.js                    # sync incrémental
DRY_RUN=true node edesk_sync.js       # test sans écriture, affiche un échantillon classifié
FULL_SYNC=true node edesk_sync.js     # ignore le curseur, retélécharge tout l'historique
```

Automatisé via `.github/workflows/edesk-sync.yml` — toutes les heures + déclenchement
manuel (Actions → eDesk Sync → Run workflow) avec options `dry_run` et `full_sync`.

Secrets GitHub requis (Settings → Secrets → Actions) :
`EDESK_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Déploiement Vercel

1. Push ce repo sur GitHub (déjà fait : `ThomasBestMob/SAV-Tracker`)
2. Sur vercel.com → Import project → ce repo
3. Framework auto-détecté : Vite
4. **Environment Variables** :
   - `VITE_SUPABASE_URL` = `https://pmxsthzdxubqbemdgtbr.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = clé **anon** Supabase (Settings → API) — jamais la
     `service_role`
   - (optionnel, pour le bouton facture PDF v2) `PRESTASHOP_API_URL`,
     `PRESTASHOP_API_KEY`
5. Deploy

## Architecture

```
src/
├── App.jsx                    ← root + routing entre les 3 onglets
├── main.jsx / index.css       ← entry Vite
├── supabaseClient.js          ← client Supabase (clé anon)
├── lib/
│   └── priority.js            ← classification + scoring de priorité des tickets
│                                 (partagé avec sync/edesk_sync.js, import direct)
├── components/
│   ├── Header.jsx
│   └── Atoms.jsx               ← Stat / Card / SectionTitle / PriorityBadge / CategoryPill
└── views/
    ├── Tickets.jsx             ← synthèse, courbe tickets/ventes, file priorisée, facture PDF
    ├── Notation.jsx            ← note (saisie manuelle) + taux SAV par canal
    └── Products.jsx            ← top 50 taux SAV, recherche par réf, détail en rond

sync/
└── edesk_sync.js               ← pull eDesk (tickets, messages, sales_orders, order_notes,
                                    contacts, channels, tags, tag_groups, users, templates)
                                    → upsert Supabase, classification + priorité calculées ici

api/
└── invoice.js                  ← stub Vercel function pour le téléchargement facture PDF
                                    (TODO v2 : brancher sur PrestaShop order_invoices)

migrations/
└── 20260702_sav_tracker_init.sql
```

## Méthodologie de priorisation (résumé — détail dans src/lib/priority.js)

Score 0-100 composite :
- **Sévérité de catégorie** (0-40 pts) : produit défectueux / réclamation qualité
  pèsent plus qu'une simple question produit
- **Âge du ticket** (0-30 pts) : monte vite les premières 24h (risque SLA),
  plafonne ensuite
- **Risque canal** (×1.0 à ×1.3) : un ticket en retard sur une marketplace à
  notation vendeur (Amazon, Cdiscount...) coûte plus cher qu'un ticket site direct
- **Valeur de la commande** (0-15 pts, échelle log)
- **Mots-clés d'urgence** dans le sujet (+15 pts)
- **Relances multiples** — 5+ messages échangés (+10 pts)
- **Bonus "quick win"** — catégories rapides à traiter type demande de facture
  (+8 pts), pour désengorger la file même si peu "graves" en soi

Seuils : ≥70 critique · ≥45 haute · ≥20 normale · <20 basse.

Classification en 7 catégories (facture, livraison, produit défectueux,
retour/remboursement, info produit, réclamation qualité, autre) via les tags
eDesk existants en priorité, mots-clés en repli.

## Prochaines étapes (non couvertes en v1)

- Vérifier le mapping exact des champs eDesk une fois un jeton réel disponible
  (voir avertissement en haut de ce fichier)
- Brancher `api/invoice.js` sur la ressource `order_invoices` PrestaShop
- Éventuelle intégration des notes vendeur marketplace par marketplace (pas
  disponible via eDesk dans le périmètre actuel du jeton)
- Rediffusion dans `marketplace-tracker` (comme `veille_tracker.js`) une fois
  la v1 validée
