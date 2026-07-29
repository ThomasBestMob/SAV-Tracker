-- ══════════════════════════════════════════════════════════════════════
-- Fondation v2 : rattachement ticket → commande PrestaShop → produits/facture,
-- et canaux canoniques alignés sur marketplace-tracker.
--
-- Constat qui motive cette migration :
--   sav_tickets.order_refs contient les SKU *marketplace* renvoyés par eDesk
--   (ex. "LIS1712708297239"), alors que le catalogue et ps_sales_daily
--   travaillent sur la réf *PrestaShop* (ex. "1366BEI"). Deux référentiels
--   distincts -> la vue sav_product_stats ne pouvait rien joindre, d'où des
--   stats produit vides.
--
--   Or ps_sales_daily (alimenté par marketplace-tracker, même base) porte déjà
--   le pont : order_id PS, order_reference PS, lengow_marketplace_order_id
--   (= orders.reference_marketplace, la réf commande marketplace), product_ref
--   réel et marketplace canonique. On rattache donc par la référence commande,
--   pas par le SKU.
-- ══════════════════════════════════════════════════════════════════════

-- ── Index de jointure sur ps_sales_daily ─────────────────────────────
-- Table appartenant à marketplace-tracker : on n'ajoute que des index
-- (non destructif, bénéfique aussi pour ce repo-là).
CREATE INDEX IF NOT EXISTS idx_ps_sales_daily_mp_order_ref
  ON ps_sales_daily (lengow_marketplace_order_id)
  WHERE lengow_marketplace_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ps_sales_daily_order_ref
  ON ps_sales_daily (order_reference);
CREATE INDEX IF NOT EXISTS idx_ps_sales_daily_order_id
  ON ps_sales_daily (order_id);

-- ══════════════════════════════════════════════════════════════════════
-- 0. Suivi de livraison sur le ticket
-- Le payload commande eDesk embarque déjà tracking_codes[] (n° + transporteur)
-- et sales_order_delivery_dates (fenêtre de livraison estimée) : de quoi
-- répondre aux "où est ma commande ?" sans aucune intégration transporteur.
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS tracking_code          TEXT;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS carrier                TEXT;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS tracking_url           TEXT;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS shipped_at             TIMESTAMPTZ;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS expected_delivery_from TIMESTAMPTZ;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS expected_delivery_to   TIMESTAMPTZ;

-- ══════════════════════════════════════════════════════════════════════
-- 1. Canaux canoniques (mêmes clés que marketplace-tracker)
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sav_channel_map (
  edesk_channel_id  BIGINT PRIMARY KEY,
  channel_key       TEXT NOT NULL,   -- site | cdiscount | amazon | ...
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE sav_channel_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read sav_channel_map"   ON sav_channel_map;
DROP POLICY IF EXISTS "public write sav_channel_map"  ON sav_channel_map;
DROP POLICY IF EXISTS "public update sav_channel_map" ON sav_channel_map;
CREATE POLICY "public read sav_channel_map"   ON sav_channel_map FOR SELECT USING (true);
CREATE POLICY "public write sav_channel_map"  ON sav_channel_map FOR INSERT WITH CHECK (true);
CREATE POLICY "public update sav_channel_map" ON sav_channel_map FOR UPDATE USING (true);

-- Déduction du canal canonique depuis le libellé eDesk. Les 33 canaux eDesk
-- sont des comptes/boutiques (un par pays, par compte marchand...) alors que le
-- pilotage se fait sur 9 canaux. sav_channel_map permet de corriger à la main
-- les cas que cette heuristique rate.
CREATE OR REPLACE FUNCTION sav_channel_key_from_name(p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN n LIKE '%amazon%'                                  THEN 'amazon'
    WHEN n LIKE '%cdiscount%'                               THEN 'cdiscount'
    WHEN n LIKE '%laredoute%'    OR n LIKE '%redoute%'      THEN 'laredoute'
    WHEN n LIKE '%maisonsdumonde%' OR n LIKE '%mdm%'        THEN 'maisonsdumonde'
    WHEN n LIKE '%conforama%'                               THEN 'conforama'
    WHEN n LIKE '%manomano%'                                THEN 'manomano'
    WHEN n LIKE '%leroymerlin%'  OR n LIKE '%leroy%'        THEN 'leroymerlin'
    WHEN n LIKE '%but%'                                     THEN 'but'
    WHEN n LIKE '%bestmobilier%' OR n LIKE '%site%'
      OR n LIKE '%shop%'         OR n LIKE '%prestashop%'
      OR n LIKE '%web%'          OR n LIKE '%mail%'         THEN 'site'
    ELSE NULL
  END
  FROM (SELECT regexp_replace(lower(COALESCE(p_name, '')), '[^a-z0-9]', '', 'g') AS n) x;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 2. Rattachement commande eDesk → commande PrestaShop
--
-- Formats de seller_order_id observés en prod, d'où les 3 règles :
--   "2605131521VS9EP"      -> réf marketplace brute
--   "011942999-A"          -> réf marketplace + suffixe canal
--   "555636 (BFGAXACUI)"   -> n° marketplace + réf PrestaShop entre parenthèses
-- Trois jointures distinctes plutôt qu'un OR : chacune peut utiliser son index.
-- match_rule est conservé pour mesurer la fiabilité du rattachement (essentiel
-- avant d'automatiser quoi que ce soit d'envoi client).
-- ══════════════════════════════════════════════════════════════════════
-- Les vues sont supprimées puis recréées, pas remplacées : CREATE OR REPLACE
-- VIEW n'autorise que l'ajout de colonnes en fin de liste, or sav_product_stats
-- existe déjà et gagne ici des colonnes en milieu de liste (product_name,
-- top_category). Ordre inverse des dépendances.
DROP VIEW IF EXISTS sav_product_stats;
DROP VIEW IF EXISTS sav_channel_stats;
DROP VIEW IF EXISTS sav_ticket_enriched;
DROP VIEW IF EXISTS sav_order_link;

CREATE VIEW sav_order_link AS
WITH refs AS (
  SELECT
    id                                                              AS sales_order_id,
    order_reference                                                 AS edesk_ref,
    substring(order_reference FROM '\(([A-Za-z0-9]{6,})\)')          AS ps_ref,
    regexp_replace(order_reference, '-[A-Za-z]$', '')                AS mp_ref
  FROM sav_sales_orders
  WHERE order_reference IS NOT NULL AND order_reference <> ''
),
hits AS (
  SELECT r.sales_order_id, p.order_id, 1 AS prio
  FROM refs r
  JOIN ps_sales_daily p ON p.lengow_marketplace_order_id = r.edesk_ref
  UNION ALL
  SELECT r.sales_order_id, p.order_id, 2
  FROM refs r
  JOIN ps_sales_daily p ON p.lengow_marketplace_order_id = r.mp_ref
  WHERE r.mp_ref <> r.edesk_ref
  UNION ALL
  SELECT r.sales_order_id, p.order_id, 3
  FROM refs r
  JOIN ps_sales_daily p ON p.order_reference = r.ps_ref
  WHERE r.ps_ref IS NOT NULL
),
best AS (
  SELECT DISTINCT ON (sales_order_id) sales_order_id, order_id, prio
  FROM hits
  ORDER BY sales_order_id, prio, order_id DESC
)
SELECT
  b.sales_order_id,
  b.order_id                                  AS ps_order_id,
  b.prio                                      AS match_rule,
  MIN(p.order_reference)                      AS ps_order_reference,
  MIN(p.marketplace)                          AS channel_key,
  MIN(p.order_state)                          AS ps_order_state,
  ARRAY_AGG(DISTINCT p.product_ref)           AS product_refs,
  ARRAY_AGG(DISTINCT p.product_name)          AS product_names,
  ROUND(SUM(p.revenue_ttc)::NUMERIC, 2)       AS order_value_ttc
FROM best b
JOIN ps_sales_daily p ON p.order_id = b.order_id
GROUP BY b.sales_order_id, b.order_id, b.prio;

-- ══════════════════════════════════════════════════════════════════════
-- 3. Vue ticket enrichie — socle de toutes les vues du front
--
-- channel_key : priorité au canal PrestaShop de la commande rattachée (source
-- de vérité, déjà canonique), sinon override manuel, sinon déduction du nom.
-- product_refs : vraies réfs PS quand la commande est rattachée, sinon les SKU
-- marketplace bruts (mieux que rien pour un ticket non rattaché).
-- ══════════════════════════════════════════════════════════════════════
CREATE VIEW sav_ticket_enriched AS
SELECT
  t.id,
  t.subject,
  t.category,
  t.status,
  t.channel_id,
  t.channel_name,
  COALESCE(l.channel_key, cm.channel_key, sav_channel_key_from_name(t.channel_name), 'autre') AS channel_key,
  t.contact_id,
  t.owner_user_id,
  t.message_count,
  t.created_at,
  t.updated_at,
  t.last_message_at,
  t.first_message_body,
  t.first_message_author,
  t.priority_score,
  t.priority_level,
  t.priority_reasons,
  t.tags,
  t.order_reference                                  AS edesk_order_reference,
  t.sales_order_id,
  l.ps_order_id,
  l.ps_order_reference,
  l.ps_order_state,
  l.match_rule                                       AS order_match_rule,
  COALESCE(l.order_value_ttc, t.order_value)         AS order_value,
  COALESCE(l.product_refs, t.order_refs)             AS product_refs,
  l.product_names,
  (l.ps_order_id IS NOT NULL)                        AS has_ps_order,
  t.tracking_code,
  t.carrier,
  t.tracking_url,
  t.shipped_at,
  t.expected_delivery_from,
  t.expected_delivery_to
FROM sav_tickets t
LEFT JOIN sav_order_link  l  ON l.sales_order_id = t.sales_order_id
LEFT JOIN sav_channel_map cm ON cm.edesk_channel_id = t.channel_id;

-- ══════════════════════════════════════════════════════════════════════
-- 4. Stats produit — réécrite sur les VRAIES réfs PrestaShop
-- Le dénominateur (ventes) et le numérateur (tickets) parlent enfin le même
-- référentiel. On expose aussi le motif dominant et le nom produit, pour que
-- l'équipe offre sache de quoi on parle sans aller chercher la réf ailleurs.
-- ══════════════════════════════════════════════════════════════════════
CREATE VIEW sav_product_stats AS
WITH tickets_by_ref AS (
  SELECT unnest(e.product_refs) AS product_ref, e.id AS ticket_id, e.category, e.created_at
  FROM sav_ticket_enriched e
  WHERE e.product_refs IS NOT NULL AND array_length(e.product_refs, 1) > 0
),
tickets_90j AS (
  SELECT
    product_ref,
    COUNT(DISTINCT ticket_id) AS nb_tickets,
    MODE() WITHIN GROUP (ORDER BY category) AS top_category
  FROM tickets_by_ref
  WHERE created_at >= NOW() - INTERVAL '90 days'
  GROUP BY product_ref
),
ventes_90j AS (
  SELECT product_ref, SUM(quantity) AS nb_ventes, MAX(product_name) AS product_name
  FROM ps_sales_daily
  WHERE sale_date >= (CURRENT_DATE - INTERVAL '90 days')
  GROUP BY product_ref
)
SELECT
  COALESCE(t.product_ref, v.product_ref) AS product_ref,
  v.product_name,
  COALESCE(t.nb_tickets, 0)              AS nb_tickets_90j,
  COALESCE(v.nb_ventes, 0)               AS nb_ventes_90j,
  t.top_category,
  CASE WHEN COALESCE(v.nb_ventes, 0) > 0
       THEN ROUND(COALESCE(t.nb_tickets, 0)::NUMERIC / v.nb_ventes * 100, 2)
       ELSE NULL
  END AS taux_sav_pct
FROM tickets_90j t
FULL OUTER JOIN ventes_90j v ON v.product_ref = t.product_ref;

-- ══════════════════════════════════════════════════════════════════════
-- 5. Taux de contact par canal — le volume brut de tickets n'est pas
-- interprétable (un canal a plus de tickets parce qu'il vend plus). Ce qui se
-- pilote, c'est le nombre de tickets rapporté au nombre de commandes.
-- ══════════════════════════════════════════════════════════════════════
CREATE VIEW sav_channel_stats AS
WITH tickets AS (
  SELECT channel_key, COUNT(*) AS nb_tickets,
         MODE() WITHIN GROUP (ORDER BY category) AS top_category
  FROM sav_ticket_enriched
  WHERE created_at >= NOW() - INTERVAL '30 days'
  GROUP BY channel_key
),
commandes AS (
  SELECT marketplace AS channel_key, COUNT(DISTINCT order_id) AS nb_commandes
  FROM ps_sales_daily
  WHERE sale_date >= (CURRENT_DATE - INTERVAL '30 days')
  GROUP BY marketplace
)
SELECT
  COALESCE(t.channel_key, c.channel_key) AS channel_key,
  COALESCE(t.nb_tickets, 0)              AS nb_tickets_30j,
  COALESCE(c.nb_commandes, 0)            AS nb_commandes_30j,
  t.top_category,
  CASE WHEN COALESCE(c.nb_commandes, 0) > 0
       THEN ROUND(COALESCE(t.nb_tickets, 0)::NUMERIC / c.nb_commandes * 100, 2)
       ELSE NULL
  END AS taux_contact_pct
FROM tickets t
FULL OUTER JOIN commandes c ON c.channel_key = t.channel_key;

-- ── Accès lecture pour le front (clé anon) ───────────────────────────
-- Explicite plutôt que de compter sur les privilèges par défaut : une vue non
-- accessible remonte silencieusement un résultat vide côté front, exactement
-- le symptôme qu'on cherche à éliminer.
GRANT SELECT ON sav_order_link      TO anon, authenticated;
GRANT SELECT ON sav_ticket_enriched TO anon, authenticated;
GRANT SELECT ON sav_product_stats   TO anon, authenticated;
GRANT SELECT ON sav_channel_stats   TO anon, authenticated;
