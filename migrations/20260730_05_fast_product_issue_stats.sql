-- ══════════════════════════════════════════════════════════════════════
-- sav_product_issue_stats : réécriture pour éviter le timeout
--
-- Problème : la vue passait par sav_ticket_enriched, qui joint maintenant
-- sav_ticket_raw_link (4 règles UNION ALL sur ps_sales_daily). Sur 2283
-- tickets, cette jointure dépasse le statement_timeout Supabase (~8s).
--
-- Solution : interroger sav_tickets directement.
--   • product_issues  → colonne indexée GIN, filtrage instantané
--   • product_refs    → extrait du JSON embarqué (sales_order.order_items)
--                       OU t.order_refs, sans jointure externe
--   • is_customer_request → first_message_direction = 'inbound' (colonne simple)
--   • ventes          → jointure ps_sales_daily par product_ref seulement
--                       (sans passer par l'order_id), beaucoup plus légère
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW sav_product_issue_stats AS
WITH tickets_base AS (
  -- On ne lit que les colonnes utiles, sans aucune jointure.
  -- Le GIN index sur product_issues rend le WHERE très rapide.
  SELECT
    t.id,
    t.created_at,
    t.product_issues,
    COALESCE(
      -- Refs PrestaShop depuis le JSON commande embarqué (présent sur ~1500 tickets)
      (SELECT array_agg(DISTINCT elem #>> '{product,sku}')
       FROM jsonb_array_elements(t.raw #> '{sales_order,order_items}') AS elem
       WHERE elem #>> '{product,sku}' IS NOT NULL),
      t.order_refs
    ) AS product_refs
  FROM sav_tickets t
  WHERE t.product_issues IS NOT NULL
    AND array_length(t.product_issues, 1) > 0
    AND (COALESCE(t.first_message_direction, 'inbound') = 'inbound')
    AND t.created_at >= NOW() - INTERVAL '180 days'
),
exploded AS (
  -- CROSS JOIN LATERAL : chaque combinaison (issue, product_ref) donne une ligne.
  SELECT
    issue_val              AS issue,
    ref_val                AS product_ref,
    tb.created_at
  FROM tickets_base tb
  CROSS JOIN LATERAL unnest(tb.product_issues)  AS _(issue_val)
  CROSS JOIN LATERAL unnest(COALESCE(tb.product_refs, ARRAY[]::text[])) AS __(ref_val)
  WHERE ref_val IS NOT NULL AND ref_val <> ''
),
agg AS (
  SELECT
    product_ref,
    issue,
    COUNT(DISTINCT created_at::date || product_ref || issue) AS nb_tickets,
    MAX(created_at) AS dernier_ticket_at
  FROM exploded
  GROUP BY product_ref, issue
),
ventes AS (
  -- Jointure légère : par product_ref seulement, pas par order_id
  SELECT product_ref,
         SUM(quantity)       AS nb_ventes,
         MAX(product_name)   AS product_name
  FROM ps_sales_daily
  WHERE sale_date >= (CURRENT_DATE - INTERVAL '180 days')
    AND product_ref IS NOT NULL
  GROUP BY product_ref
)
SELECT
  a.product_ref,
  v.product_name,
  a.issue,
  a.nb_tickets,
  a.dernier_ticket_at,
  COALESCE(v.nb_ventes, 0)                                        AS nb_ventes_180j,
  CASE WHEN COALESCE(v.nb_ventes, 0) > 0
       THEN ROUND(a.nb_tickets::NUMERIC / v.nb_ventes * 100, 2)
       ELSE NULL
  END                                                              AS taux_sav_pct
FROM agg a
LEFT JOIN ventes v ON v.product_ref = a.product_ref;

GRANT SELECT ON sav_product_issue_stats TO anon, authenticated;

-- Vérification : SELECT count(*) FROM sav_product_issue_stats;
-- Doit répondre en < 2s.
