-- ══════════════════════════════════════════════════════════════════════
-- get_product_verbatims : fonction RPC pour le panneau verbatim
--
-- Interroge sav_tickets directement (pas sav_ticket_enriched) :
--   1. t.order_refs @> ARRAY[p_ref]  → GIN index, O(log n)
--   2. EXISTS json path               → fallback pour les refs PS/SKU
-- DISTINCT ON (t.id) évite les doublons si le même ticket matche les deux chemins.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_product_verbatims(
  p_ref   text,
  p_issue text DEFAULT NULL
)
RETURNS TABLE (
  id                    bigint,
  subject               text,
  category              text,
  created_at            timestamptz,
  channel_key           text,
  first_message_body    text,
  edesk_order_reference text,
  product_issues        text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT DISTINCT ON (t.id)
    t.id,
    t.subject,
    t.category,
    t.created_at,
    cm.channel_key,
    t.first_message_body,
    COALESCE(t.raw ->> 'order_reference', t.order_refs[1]) AS edesk_order_reference,
    t.product_issues
  FROM sav_tickets t
  LEFT JOIN sav_channel_map cm ON cm.edesk_channel_id = t.channel_id
  WHERE
    COALESCE(t.first_message_direction, 'inbound') = 'inbound'
    AND (p_issue IS NULL OR t.product_issues @> ARRAY[p_issue])
    AND (
      t.order_refs @> ARRAY[p_ref]
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(t.raw #> '{sales_order,order_items}') AS item
        WHERE item #>> '{product,sku}' = p_ref
      )
    )
  ORDER BY t.id, t.created_at DESC
  LIMIT 100;
$$;

GRANT EXECUTE ON FUNCTION get_product_verbatims(text, text) TO anon, authenticated;
