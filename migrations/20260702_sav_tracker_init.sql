-- ══════════════════════════════════════════════════════════════════
-- SAV Tracker — schéma initial (v1)
-- À exécuter dans le même projet Supabase que marketplace-tracker
-- (Supabase SQL Editor) — nouvelles tables préfixées sav_, aucun impact
-- sur les tables existantes.
-- ══════════════════════════════════════════════════════════════════
--
-- Chaque table "miroir" d'une ressource eDesk stocke :
--   - les colonnes extraites utiles au produit (filtres, jointures, affichage)
--   - une colonne `raw JSONB` avec le payload brut complet
-- Le payload brut sert de filet de sécurité : le schéma exact de l'API eDesk
-- n'a pas pu être vérifié en détail sans jeton réel (doc en ligne ne montre
-- pas les schémas de réponse interactifs). Si un champ extrait s'avère mal
-- mappé, la donnée brute est toujours là pour corriger sans re-sync.
--
-- Lien SAV <-> catalogue produit : sav_tickets.order_refs (text[]) est
-- rapproché de product_ref dans ps_sales_daily (même base) pour calculer un
-- taux de SAV réel (tickets / ventes) par référence — voir vue
-- sav_product_stats en bas de fichier.

CREATE TABLE IF NOT EXISTS sav_channels (
  id          BIGINT PRIMARY KEY,
  name        TEXT NOT NULL,
  raw         JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_contacts (
  id          BIGINT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  raw         JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_users (
  id          BIGINT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  raw         JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_tag_groups (
  id          BIGINT PRIMARY KEY,
  name        TEXT,
  raw         JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_tags (
  id            BIGINT PRIMARY KEY,
  tag_group_id  BIGINT,
  name          TEXT,
  raw           JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_templates (
  id          BIGINT PRIMARY KEY,
  name        TEXT,
  body        TEXT,
  raw         JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_sales_orders (
  id              BIGINT PRIMARY KEY,
  channel_id      BIGINT,
  order_reference TEXT,
  order_date      TIMESTAMPTZ,
  total_value     NUMERIC(12,2),
  currency        TEXT,
  order_refs      TEXT[] NOT NULL DEFAULT '{}', -- SKUs des lignes de commande, si exposés par l'API
  raw             JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_order_notes (
  id              BIGINT PRIMARY KEY,
  sales_order_id  BIGINT,
  body            TEXT,
  created_at      TIMESTAMPTZ,
  raw             JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_tickets (
  id                BIGINT PRIMARY KEY,
  sales_order_id    BIGINT,
  contact_id        BIGINT,
  channel_id        BIGINT,
  channel_name      TEXT,       -- dénormalisé depuis sav_channels pour éviter un join sur chaque requête de tri/filtre
  owner_user_id     BIGINT,
  status            TEXT,
  type              TEXT,
  subject           TEXT,
  category          TEXT,       -- classification maison (voir src/lib/priority.js)
  priority_score    NUMERIC(5,1) DEFAULT 0,
  priority_level    TEXT,       -- critique | haute | normale | basse
  priority_reasons  JSONB NOT NULL DEFAULT '[]',
  tags              TEXT[] NOT NULL DEFAULT '{}',
  message_count     INTEGER DEFAULT 0,
  order_value       NUMERIC(12,2),
  order_refs        TEXT[] NOT NULL DEFAULT '{}', -- dénormalisé depuis sav_sales_orders.order_refs
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  last_message_at   TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  raw               JSONB NOT NULL DEFAULT '{}',
  synced_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_messages (
  id            BIGINT PRIMARY KEY,
  ticket_id     BIGINT NOT NULL,
  direction     TEXT,           -- inbound | outbound
  body          TEXT,
  author_name   TEXT,
  created_at    TIMESTAMPTZ,
  raw           JSONB NOT NULL DEFAULT '{}'
);

-- État du sync incrémental par ressource (mirroring sync/ps_sync.js -> ps_sync_state)
CREATE TABLE IF NOT EXISTS sav_sync_state (
  resource        TEXT PRIMARY KEY,
  last_synced_at  TIMESTAMPTZ,
  cursor          TEXT
);

-- ── Index ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sav_tickets_status        ON sav_tickets (status);
CREATE INDEX IF NOT EXISTS idx_sav_tickets_category       ON sav_tickets (category);
CREATE INDEX IF NOT EXISTS idx_sav_tickets_priority       ON sav_tickets (priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_sav_tickets_channel        ON sav_tickets (channel_id);
CREATE INDEX IF NOT EXISTS idx_sav_tickets_created        ON sav_tickets (created_at);
CREATE INDEX IF NOT EXISTS idx_sav_tickets_order_refs     ON sav_tickets USING GIN (order_refs);
CREATE INDEX IF NOT EXISTS idx_sav_messages_ticket        ON sav_messages (ticket_id);
CREATE INDEX IF NOT EXISTS idx_sav_sales_orders_refs      ON sav_sales_orders USING GIN (order_refs);

-- ── RLS lecture publique (clé anon, front Vite) ─────────────────────
-- Écriture réservée à service_role (sync GitHub Actions), comme pour
-- dashboard-veille.
ALTER TABLE sav_channels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_contacts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_tag_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_tags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_order_notes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sav_sync_state   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read sav_channels"     ON sav_channels;
DROP POLICY IF EXISTS "public read sav_contacts"     ON sav_contacts;
DROP POLICY IF EXISTS "public read sav_users"        ON sav_users;
DROP POLICY IF EXISTS "public read sav_tag_groups"   ON sav_tag_groups;
DROP POLICY IF EXISTS "public read sav_tags"         ON sav_tags;
DROP POLICY IF EXISTS "public read sav_templates"    ON sav_templates;
DROP POLICY IF EXISTS "public read sav_sales_orders" ON sav_sales_orders;
DROP POLICY IF EXISTS "public read sav_order_notes"  ON sav_order_notes;
DROP POLICY IF EXISTS "public read sav_tickets"      ON sav_tickets;
DROP POLICY IF EXISTS "public read sav_messages"     ON sav_messages;
DROP POLICY IF EXISTS "public read sav_sync_state"   ON sav_sync_state;

CREATE POLICY "public read sav_channels"     ON sav_channels     FOR SELECT USING (true);
CREATE POLICY "public read sav_contacts"     ON sav_contacts     FOR SELECT USING (true);
CREATE POLICY "public read sav_users"        ON sav_users        FOR SELECT USING (true);
CREATE POLICY "public read sav_tag_groups"   ON sav_tag_groups   FOR SELECT USING (true);
CREATE POLICY "public read sav_tags"         ON sav_tags         FOR SELECT USING (true);
CREATE POLICY "public read sav_templates"    ON sav_templates    FOR SELECT USING (true);
CREATE POLICY "public read sav_sales_orders" ON sav_sales_orders FOR SELECT USING (true);
CREATE POLICY "public read sav_order_notes"  ON sav_order_notes  FOR SELECT USING (true);
CREATE POLICY "public read sav_tickets"      ON sav_tickets      FOR SELECT USING (true);
CREATE POLICY "public read sav_messages"     ON sav_messages     FOR SELECT USING (true);
CREATE POLICY "public read sav_sync_state"   ON sav_sync_state   FOR SELECT USING (true);

-- ══════════════════════════════════════════════════════════════════
-- Vue : taux de SAV par référence produit (onglet "Stats produit")
-- tickets_90j = nb tickets SAV liés à ce product_ref sur 90 jours
-- ventes_90j  = nb unités vendues sur ce product_ref sur 90 jours (ps_sales_daily)
-- taux_sav    = tickets / ventes * 100, NULL si pas de ventes (évite /0 et
--               les faux "100% SAV" sur un produit à 1 vente/1 ticket)
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW sav_product_stats AS
WITH tickets_by_ref AS (
  SELECT
    unnest(t.order_refs) AS product_ref,
    t.id AS ticket_id,
    t.category,
    t.created_at
  FROM sav_tickets t
  WHERE t.order_refs IS NOT NULL AND array_length(t.order_refs, 1) > 0
),
tickets_90j AS (
  SELECT product_ref, COUNT(DISTINCT ticket_id) AS nb_tickets
  FROM tickets_by_ref
  WHERE created_at >= NOW() - INTERVAL '90 days'
  GROUP BY product_ref
),
ventes_90j AS (
  SELECT product_ref, SUM(quantity) AS nb_ventes
  FROM ps_sales_daily
  WHERE sale_date >= (CURRENT_DATE - INTERVAL '90 days')
  GROUP BY product_ref
)
SELECT
  COALESCE(t.product_ref, v.product_ref) AS product_ref,
  COALESCE(t.nb_tickets, 0)              AS nb_tickets_90j,
  COALESCE(v.nb_ventes, 0)               AS nb_ventes_90j,
  CASE WHEN COALESCE(v.nb_ventes, 0) > 0
       THEN ROUND(COALESCE(t.nb_tickets, 0)::NUMERIC / v.nb_ventes * 100, 2)
       ELSE NULL
  END AS taux_sav_pct
FROM tickets_90j t
FULL OUTER JOIN ventes_90j v ON v.product_ref = t.product_ref;

-- ══════════════════════════════════════════════════════════════════
-- Notation manuelle par canal (onglet "Notation")
-- L'API eDesk (scope actuel) n'expose pas de ressource "ratings" — la note
-- vendeur vient de chaque marketplace individuellement, pas d'eDesk. Saisie
-- manuelle en attendant une éventuelle intégration marketplace par marketplace.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sav_channel_ratings (
  id          BIGSERIAL PRIMARY KEY,
  channel_id  BIGINT NOT NULL,
  period      DATE NOT NULL,       -- 1er du mois concerné
  rating      NUMERIC(3,2),        -- ex. 4.60 / 5
  notes       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (channel_id, period)
);
ALTER TABLE sav_channel_ratings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read sav_channel_ratings"   ON sav_channel_ratings;
DROP POLICY IF EXISTS "public write sav_channel_ratings"  ON sav_channel_ratings;
DROP POLICY IF EXISTS "public update sav_channel_ratings" ON sav_channel_ratings;
CREATE POLICY "public read sav_channel_ratings"  ON sav_channel_ratings FOR SELECT USING (true);
CREATE POLICY "public write sav_channel_ratings" ON sav_channel_ratings FOR INSERT WITH CHECK (true);
CREATE POLICY "public update sav_channel_ratings" ON sav_channel_ratings FOR UPDATE USING (true);
-- Saisie ouverte au rôle anon (comme un formulaire interne, cf. revenue_entries
-- dans marketplace-tracker) : app interne à accès restreint, pas de données
-- sensibles exposées au-delà de ce que l'équipe SAV saisit elle-même.

-- Les vues s'exécutent avec les droits de leur créateur (comportement par défaut
-- Postgres) : pas besoin que le rôle anon ait accès direct à ps_sales_daily,
-- juste un GRANT explicite sur la vue elle-même pour que PostgREST/Supabase
-- l'expose côté API (comme pour les tables sav_*, mais une vue n'a pas de RLS).
GRANT SELECT ON sav_product_stats TO anon, authenticated;
