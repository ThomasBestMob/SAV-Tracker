-- ══════════════════════════════════════════════════════════════════════
-- Règle 4 : rattachement des tickets site via la référence commande PS directe
--
-- Constat après migration 03 (30/07/2026) :
--   Canal "site" : 33.9% (442/1302) — le plus bas de tous les canaux.
--   Les marketplaces sont à 77-100% car external_order_id = seller_order_id
--   (référence marketplace), ce qu'on sait joindre.
--
--   Pour les tickets "site" (email, formulaire), le client cite souvent
--   directement sa référence commande PrestaShop (ex. BSTYYYYMMDDXXXXX).
--   Cette référence n'est pas une lengow_marketplace_order_id — c'est une
--   order_reference PS directe. Les règles 1-3 ne la capturent pas.
--
--   Règle 4 : match exact entre external_order_id et ps_sales_daily.order_reference.
--   Priorité 4 (la plus basse), ne remplace jamais un match marketplace déjà trouvé.
-- ══════════════════════════════════════════════════════════════════════

-- Index sur order_reference (probablement déjà présent via migration 01,
-- mais IF NOT EXISTS garantit l'idempotence).
CREATE INDEX IF NOT EXISTS idx_ps_sales_daily_order_ref
  ON ps_sales_daily (order_reference);

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
  -- Règle 1 : correspondance exacte (réf marketplace brute)
  SELECT e.ticket_id, p.order_id, 1 AS prio FROM ext e
  JOIN ps_sales_daily p ON p.lengow_marketplace_order_id = e.ext_id

  UNION ALL
  -- Règle 2 : sans le suffixe de canal (-A, -B… ex: "011244612-A")
  SELECT e.ticket_id, p.order_id, 2 FROM ext e
  JOIN ps_sales_daily p ON p.lengow_marketplace_order_id = e.mp_ref
  WHERE e.mp_ref IS DISTINCT FROM e.ext_id

  UNION ALL
  -- Règle 3 : réf PS entre parenthèses (ex : "554605 (UGPJYIJHG)")
  SELECT e.ticket_id, p.order_id, 3 FROM ext e
  JOIN ps_sales_daily p ON p.order_reference = e.ps_ref
  WHERE e.ps_ref IS NOT NULL

  UNION ALL
  -- Règle 4 : external_order_id est directement une réf commande PS
  -- (cas fréquent sur le canal "site" : le client cite sa réf dans l'objet)
  SELECT e.ticket_id, p.order_id, 4 FROM ext e
  JOIN ps_sales_daily p ON p.order_reference = e.ext_id
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

-- Vérification post-migration :
-- SELECT channel_key, COUNT(*) tickets,
--        COUNT(*) FILTER (WHERE ps_order_id IS NOT NULL) rattaches,
--        ROUND(100.0 * COUNT(*) FILTER (WHERE ps_order_id IS NOT NULL)/COUNT(*), 1) taux_pct
-- FROM sav_ticket_enriched GROUP BY 1 ORDER BY 2 DESC;
