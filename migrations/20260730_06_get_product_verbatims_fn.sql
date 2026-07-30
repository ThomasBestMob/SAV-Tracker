-- ══════════════════════════════════════════════════════════════════════
-- get_product_verbatims : fonction RPC pour le panneau verbatim
--
-- Problème : openDetail() interrogeait sav_ticket_enriched avec
-- .contains('product_refs', [ref]), ce qui force un full scan de la vue
-- complexe (multiple LEFT JOINs + sav_ticket_raw_link). Timeout garanti.
--
-- Solution : interroger sav_tickets directement via deux chemins rapides :
--   1. t.order_refs @> ARRAY[p_ref]        → GIN index existant (très rapide)
--   2. EXISTS (json path sur sales_order)  → fallback pour les refs PS
-- La jointure sav_channel_map est O(1) sur une petite table.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_product_verbatims(
  p_ref   text,
  p_issue text DEFAULT NULL
)
RETURNS TABLE (
  id                   bigint,
  subject              text,
  category             text,
  created_at           timestamptz,
  channel_key          text,
  first_message_body   text,
  edesk_order_reference text,
  product_issues       text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    t.id,
    t.subject,
    t.category,
    t.created_at,
    cm.channel_key,
    t.first_message_body,
    -- La première référence eDesk dans order_refs sert de référence commande
    COALESCE(
      t.raw ->> 'order_reference',
      t.order_refs[1]
    ) AS edesk_order_reference,
    t.product_issues
  FROM sav_tickets t
  LEFT JOIN sav_channel_map cm ON cm.edesk_mailbox_id = t.mailbox_id
  WHERE
    -- is_customer_request = premier message entrant
    COALESCE(t.first_message_direction, 'inbound') = 'inbound'
    AND (p_issue IS NULL OR t.product_issues @> ARRAY[p_issue])
    AND (
      -- Chemin 1 : ref dans order_refs (index GIN existant, O(log n))
      t.order_refs @> ARRAY[p_ref]
      OR
      -- Chemin 2 : ref = SKU dans le JSON commande embarqué
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(t.raw #> '{sales_order,order_items}') AS item
        WHERE item #>> '{product,sku}' = p_ref
      )
    )
  ORDER BY t.created_at DESC
  LIMIT 100;
$$;

GRANT EXECUTE ON FUNCTION get_product_verbatims(text, text) TO anon, authenticated;

-- Vérification :
-- SELECT count(*) FROM get_product_verbatims('REF-EXEMPLE');
-- Doit répondre en < 1s.
