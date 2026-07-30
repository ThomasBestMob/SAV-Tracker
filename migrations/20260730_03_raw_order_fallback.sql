-- ══════════════════════════════════════════════════════════════════════
-- Exploitation du JSON brut du ticket pour les commandes hors fenêtre sync
--
-- Constat (requêtes du 30/07/2026) :
--   • 2283 tickets ont raw IS NOT NULL avec external_order_id présent.
--   • 1508 ont un sales_order_id ; leur JSON embarque la commande complète
--     (order_items.product.sku, tracking_codes, total_amount, dates livraison).
--   • Seules 296 de ces commandes existent dans sav_sales_orders (fenêtre 90j),
--     soit 1212 tickets dont les données sont disponibles mais non exploitées.
--
-- Solution : sav_ticket_raw_link mappe external_order_id → ps_sales_daily
-- avec les mêmes 3 règles que sav_order_link, mais depuis le ticket directement.
-- Dans sav_ticket_enriched, ce join devient le fallback quand sav_order_link
-- ne trouve pas (l.ps_order_id IS NULL). Les données de commande embarquées
-- (refs produit, suivi, montant) sont utilisées si aucune des deux vues ne
-- trouve une correspondance PS.
-- ══════════════════════════════════════════════════════════════════════

-- Dépendance : sav_try_timestamptz doit exister (créée dans migration 02).
-- On la recrée ici en CREATE OR REPLACE pour que cette migration soit
-- autosuffisante si 02 n'a pas encore été jouée.
CREATE OR REPLACE FUNCTION sav_try_timestamptz(p TEXT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  RETURN p::TIMESTAMPTZ;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- ── Index sur le champ JSON external_order_id ─────────────────────────
-- Évite un seq scan de sav_tickets à chaque requête sur la vue.
CREATE INDEX IF NOT EXISTS idx_sav_tickets_ext_order_id
  ON sav_tickets ((raw ->> 'external_order_id'))
  WHERE raw ->> 'external_order_id' IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════
-- Vue sav_ticket_raw_link
-- Même logique 3-règles que sav_order_link, mais la clé de jointure vient
-- de t.raw ->> 'external_order_id' plutôt que de sav_sales_orders.
-- ══════════════════════════════════════════════════════════════════════
DROP VIEW IF EXISTS sav_ticket_raw_link;
CREATE VIEW sav_ticket_raw_link AS
WITH ext AS (
  SELECT
    id                                                                        AS ticket_id,
    raw ->> 'external_order_id'                                               AS ext_id,
    substring(raw ->> 'external_order_id' FROM '\(([A-Za-z0-9]{6,})\)')      AS ps_ref,
    regexp_replace(raw ->> 'external_order_id', '-[A-Za-z]{1,2}$', '')       AS mp_ref
  FROM sav_tickets
  WHERE raw ->> 'external_order_id' IS NOT NULL
    AND raw ->> 'external_order_id' <> ''
),
hits AS (
  -- Règle 1 : correspondance exacte
  SELECT e.ticket_id, p.order_id, 1 AS prio FROM ext e
  JOIN ps_sales_daily p ON p.lengow_marketplace_order_id = e.ext_id
  UNION ALL
  -- Règle 2 : sans le suffixe de canal (-A, -B…)
  SELECT e.ticket_id, p.order_id, 2 FROM ext e
  JOIN ps_sales_daily p ON p.lengow_marketplace_order_id = e.mp_ref
  WHERE e.mp_ref IS DISTINCT FROM e.ext_id
  UNION ALL
  -- Règle 3 : réf PS entre parenthèses (ex : "554605 (ZFDKECEKD)")
  SELECT e.ticket_id, p.order_id, 3 FROM ext e
  JOIN ps_sales_daily p ON p.order_reference = e.ps_ref
  WHERE e.ps_ref IS NOT NULL
),
best AS (
  SELECT DISTINCT ON (ticket_id) ticket_id, order_id, prio
  FROM hits
  ORDER BY ticket_id, prio, order_id DESC
)
SELECT
  b.ticket_id,
  b.order_id                              AS ps_order_id,
  b.prio                                  AS match_rule,
  MIN(p.order_reference)                  AS ps_order_reference,
  MIN(p.marketplace)                      AS channel_key,
  MIN(p.order_state)                      AS ps_order_state,
  ARRAY_AGG(DISTINCT p.product_ref)  FILTER (WHERE p.product_ref IS NOT NULL)  AS product_refs,
  ARRAY_AGG(DISTINCT p.product_name) FILTER (WHERE p.product_name IS NOT NULL) AS product_names,
  ROUND(SUM(p.revenue_ttc)::NUMERIC, 2)   AS order_value_ttc
FROM best b
JOIN ps_sales_daily p ON p.order_id = b.order_id
GROUP BY b.ticket_id, b.order_id, b.prio;

GRANT SELECT ON sav_ticket_raw_link TO anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- Recréation de sav_ticket_enriched (remplace toutes les versions précédentes)
--
-- Trois sources de rattachement par priorité décroissante :
--   l   = sav_order_link  (via sav_sales_orders, 296 tickets, précis)
--   l2  = sav_ticket_raw_link (via external_order_id, ~1400 tickets)
--   JSON embarqué dans t.raw -> 'sales_order' (refs produit, suivi, montant)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW sav_ticket_enriched AS
SELECT
  t.id,
  t.subject,
  t.category,
  t.status,
  t.channel_id,
  t.channel_name,
  COALESCE(l.channel_key, l2.channel_key, cm.channel_key,
           sav_channel_key_from_name(t.channel_name), 'autre')                  AS channel_key,
  t.contact_id,
  t.owner_user_id,
  t.message_count,
  t.created_at,
  t.updated_at,
  t.last_message_at,
  t.first_message_body,
  t.first_message_author,
  t.first_message_at,
  t.first_message_direction,
  t.last_message_direction,
  t.product_issues,

  (lower(COALESCE(t.status, '')) NOT IN (
     'closed', 'close', 'resolved', 'resolve', 'archived', 'archive',
     'spam', 'trash', 'deleted', 'ferme', 'fermé', 'resolu', 'résolu'
   ))                                                                            AS is_open,

  (COALESCE(t.last_message_direction, 'inbound') = 'inbound')                  AS awaiting_us,
  (COALESCE(t.first_message_direction, 'inbound') = 'inbound')                 AS is_customer_request,

  t.priority_score,
  t.priority_level,
  t.priority_reasons,
  t.tags,

  -- Référence commande marketplace (pour affichage dans la file)
  COALESCE(
    so.order_reference,
    t.raw ->> 'external_order_id',
    t.order_reference
  )                                                                              AS edesk_order_reference,

  t.sales_order_id,
  COALESCE(l.ps_order_id,        l2.ps_order_id)         AS ps_order_id,
  COALESCE(l.ps_order_reference, l2.ps_order_reference)  AS ps_order_reference,
  COALESCE(l.ps_order_state,     l2.ps_order_state)      AS ps_order_state,
  COALESCE(l.match_rule,         l2.match_rule)           AS order_match_rule,

  COALESCE(
    l.order_value_ttc,
    l2.order_value_ttc,
    so.total_value,
    (t.raw #>> '{sales_order,total_amount}')::numeric,
    t.order_value
  )                                                                              AS order_value,

  -- Réfs produit : vraies réfs PS si rattaché, sinon SKU embarqués dans le JSON
  -- ticket (product.sku dans order_items — déjà les réfs PrestaShop pour le
  -- site, les SKU marketplace pour Amazon/Cdiscount), sinon SKU bruts du ticket.
  COALESCE(
    l.product_refs,
    l2.product_refs,
    (SELECT array_agg(DISTINCT elem #>> '{product,sku}')
     FROM jsonb_array_elements(t.raw #> '{sales_order,order_items}') AS elem
     WHERE elem #>> '{product,sku}' IS NOT NULL),
    so.order_refs,
    t.order_refs
  )                                                                              AS product_refs,

  COALESCE(l.product_names, l2.product_names)             AS product_names,
  (COALESCE(l.ps_order_id, l2.ps_order_id) IS NOT NULL)  AS has_ps_order,

  -- Suivi : colonnes ticket (écrites par le sync) > sav_sales_orders > JSON embarqué
  COALESCE(
    t.tracking_code,
    btrim(so.raw #>> '{tracking_codes,0,tracking_code}',         '''" '),
    btrim(t.raw #>> '{sales_order,tracking_codes,0,tracking_code}', '''" ')
  )                                                                              AS tracking_code,

  COALESCE(
    t.carrier,
    so.raw #>> '{tracking_codes,0,tracking_carrier_name}',
    t.raw #>> '{sales_order,tracking_codes,0,tracking_carrier_name}'
  )                                                                              AS carrier,

  COALESCE(
    t.tracking_url,
    so.raw #>> '{tracking_codes,0,tracking_link}',
    t.raw #>> '{sales_order,tracking_codes,0,tracking_link}'
  )                                                                              AS tracking_url,

  COALESCE(
    t.shipped_at,
    sav_try_timestamptz(so.raw ->> 'order_shipped_at'),
    sav_try_timestamptz(t.raw #>> '{sales_order,order_shipped_at}')
  )                                                                              AS shipped_at,

  COALESCE(
    t.expected_delivery_from,
    sav_try_timestamptz(so.raw #>> '{sales_order_delivery_dates,expected_delivery_from}'),
    sav_try_timestamptz(t.raw #>> '{sales_order,sales_order_delivery_dates,expected_delivery_from}')
  )                                                                              AS expected_delivery_from,

  COALESCE(
    t.expected_delivery_to,
    sav_try_timestamptz(so.raw #>> '{sales_order_delivery_dates,expected_delivery_to}'),
    sav_try_timestamptz(t.raw #>> '{sales_order,sales_order_delivery_dates,expected_delivery_to}')
  )                                                                              AS expected_delivery_to

FROM sav_tickets t
LEFT JOIN sav_sales_orders     so ON so.id = t.sales_order_id
LEFT JOIN sav_order_link       l  ON l.sales_order_id = t.sales_order_id
LEFT JOIN sav_ticket_raw_link  l2 ON l2.ticket_id = t.id
LEFT JOIN sav_channel_map      cm ON cm.edesk_channel_id = t.channel_id;

-- ── Accès lecture ─────────────────────────────────────────────────────
GRANT SELECT ON sav_ticket_enriched TO anon, authenticated;
