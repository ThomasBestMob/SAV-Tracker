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
   - (pour le bouton facture PDF) `PRESTASHOP_ADMIN_URL`,
     `PRESTASHOP_ADMIN_EMAIL`, `PRESTASHOP_ADMIN_PASSWORD`
5. Deploy

## Architecture

```
src/
├── App.jsx                    ← root + routing entre les 3 onglets
├── main.jsx / index.css       ← entry Vite
├── supabaseClient.js          ← client Supabase (clé anon)
├── lib/
│   ├── priority.js            ← classification des tickets en catégories
│   │                             (partagé avec sync/edesk_sync.js, import direct)
│   └── triage.js              ← SLA par canal, action à faire, réponses pré-rédigées
│                                 (front uniquement : dépend de l'heure courante)
├── components/
│   ├── Header.jsx
│   └── Atoms.jsx               ← Stat / Card / SectionTitle / PriorityBadge / CategoryPill
└── views/
    ├── Queue.jsx               ← "Ma journée" : file triée par échéance SLA, action + matériel
    ├── Products.jsx            ← anomalies produit : taux SAV + verbatims clients
    └── Channels.jsx            ← pilotage canal : respect SLA, taux de contact

sync/
└── edesk_sync.js               ← pull eDesk (tickets, sales_orders, order_notes, contacts,
                                    channels, tag_groups, users, templates) → upsert Supabase

api/
└── invoice.js                  ← PDF de facture via le back-office PrestaShop (Playwright)

migrations/
├── 20260702_sav_tracker_init.sql
├── 20260703_ticket_order_reference.sql   ← réf commande + 1er message client
└── 20260729_order_link_and_channels.sql  ← rattachement PrestaShop, canaux, vues v2
```

## Le rattachement ticket → commande PrestaShop

C'est le socle du produit, et il ne coûte aucune intégration supplémentaire :
`ps_sales_daily` (alimenté par **marketplace-tracker**, même base Supabase) porte
déjà `order_id` PrestaShop, `lengow_marketplace_order_id` (= la réf commande
marketplace) et le `product_ref` réel.

On rattache donc par la **référence commande**, pas par le SKU — trois formats
observés en prod, d'où les trois règles de la vue `sav_order_link` :

| Format eDesk (`seller_order_id`) | Règle |
|---|---|
| `2605131521VS9EP` | réf marketplace brute |
| `011942999-A` | réf marketplace + suffixe canal |
| `555636 (BFGAXACUI)` | n° marketplace + réf PrestaShop entre parenthèses |

Ce rattachement débloque d'un coup : la **facture** (il faut l'`order_id` PS),
les **vraies réfs produit** (le SKU marketplace ne matche pas le catalogue), et
le **canal canonique** (déjà normalisé dans `ps_sales_daily.marketplace`).

Le taux de rattachement est affiché par canal dans l'onglet Pilotage : sous 70 %,
le format de référence du canal est probablement mal reconnu.

## Priorisation : échéance, pas score (détail dans src/lib/triage.js)

La file est triée par **échéance de réponse** (SLA du canal appliqué au dernier
message), pas par un score composite : un agent doit pouvoir justifier l'ordre de
traitement sans connaître la formule.

SLA par canal — heures calendaires, comme les marketplaces les comptent :
Amazon / Cdiscount / ManoMano / site 24 h, autres marketplaces 48 h.

Chaque ticket porte aussi une **action** déduite de la catégorie **et** du
matériel disponible (une demande de facture sans commande rattachée n'est pas la
même tâche qu'une facture prête à envoyer), plus le matériel pour l'exécuter :
n° de suivi, lien transporteur, réponse pré-rédigée, PDF de facture.

## Les trois états d'un ticket

Une file qui mélange « le client attend ma réponse » et « j'ai répondu, j'attends
le client » ne peut pas être vidée, donc ne se travaille pas. L'état vient du
**sens du dernier message** du fil (`last_message_direction`) :

| État | Sens | Compteur SLA |
|---|---|---|
| **À traiter** | dernier message du client | oui |
| **En attente client** | dernier message de nous | non — le retard n'est pas le nôtre |
| **Notifications** | *premier* message de nous | non |

Le troisième état existe parce qu'eDesk ingère aussi nos propres mails
transactionnels (« [Best Mobilier] Paiement accepté ») comme des tickets. Un fil
dont le premier message sort de chez nous n'est pas une demande client.

## Deux axes de classification, pas un

- `category` (src/lib/priority.js) — la **démarche** : facture, livraison,
  retour… C'est ce dont l'équipe SAV a besoin pour savoir quel geste faire.
- `product_issues` (src/lib/productIssues.js) — le **défaut produit** : casse,
  affaissement, couleur vs photo, pièce manquante… C'est ce dont l'équipe offre a
  besoin, et `category` ne le dit pas : un ticket « retour_remboursement » peut
  avoir pour cause réelle un affaissement d'assise.

Les deux sont indépendants. Un ticket porte **plusieurs** défauts produit si le
message en mentionne plusieurs — forcer un motif unique ferait disparaître des
signaux. La détection lit le sujet **et** le corps du premier message : sur les
marketplaces le sujet est souvent un libellé générique imposé par la plateforme,
tout le contenu est dans le corps.

## Automatisations — règle de sécurité

Les réponses pré-rédigées sont **toujours relues par un agent avant envoi**.
Deux raisons non négociables :

- **Ne jamais contacter un client marketplace hors plateforme** (Amazon,
  Cdiscount…) : c'est un motif de suspension de compte. La réponse doit repartir
  par eDesk. L'e-mail direct n'est acceptable que pour les commandes du site.
- **Un mauvais rattachement de commande = fuite de données personnelles** (la
  facture d'un autre client). Le taux de rattachement doit être vérifié par canal
  avant d'envisager le moindre envoi automatique.

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
