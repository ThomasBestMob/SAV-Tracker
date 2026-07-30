-- ══════════════════════════════════════════════════════════════════════
-- Le ticket atteint sa commande par jointure, non par colonne dénormalisée.
--
-- Constat en prod : sur 2283 tickets, 1508 portent bien un `sales_order_id`,
-- mais `order_reference` est renseigné sur ZÉRO d'entre eux. Cette colonne n'est
-- écrite que par le sync eDesk, et aucun run complet n'a eu lieu depuis son
-- ajout. Résultat : le front n'affichait aucune référence commande, "Commandes
-- rattachées" restait à "—", et le nom des factures téléchargées était vide.
--
-- Or la référence est déjà en base, dans sav_sales_orders. Dépendre d'une copie
-- dénormalisée obligeait à un sync eDesk complet (45 min) pour une donnée
-- immédiatement disponible par jointure — et l'accès eDesk est actuellement
-- indisponible (jeton expiré, compte inaccessible). On joint donc directement.
--
-- Même logique pour les réfs produit et le montant : la source de vérité est la
-- commande, la colonne du ticket n'est qu'un repli.
--
-- CREATE OR REPLACE et non DROP : la liste de colonnes, leurs noms, leurs types
-- et leur ordre sont inchangés — seules les expressions changent. Les vues qui
-- en dépendent (sav_product_stats, sav_product_issue_stats, sav_channel_stats)
-- restent donc valides et n'ont pas à être recréées.
-- ══════════════════════════════════════════════════════════════════════

-- Conversion tolérante : les dates viennent du JSON brut eDesk, et un seul
-- format inattendu ferait échouer la vue entière — donc toute la page. Un NULL
-- sur une ligne est préférable à une vue cassée.
-- STABLE et non IMMUTABLE : le résultat d'un cast en timestamptz dépend du
-- paramètre TimeZone de la session.
CREATE OR REPLACE FUNCTION sav_try_timestamptz(p TEXT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  RETURN p::TIMESTAMPTZ;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE VIEW sav_ticket_enriched AS
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
  t.first_message_at,
  t.first_message_direction,
  t.last_message_direction,
  t.product_issues,

  (lower(COALESCE(t.status, '')) NOT IN (
     'closed', 'close', 'resolved', 'resolve', 'archived', 'archive',
     'spam', 'trash', 'deleted', 'ferme', 'fermé', 'resolu', 'résolu'
   )) AS is_open,

  (COALESCE(t.last_message_direction, 'inbound') = 'inbound') AS awaiting_us,
  (COALESCE(t.first_message_direction, 'inbound') = 'inbound') AS is_customer_request,

  t.priority_score,
  t.priority_level,
  t.priority_reasons,
  t.tags,

  -- Référence commande : la commande eDesk d'abord (source de vérité), la
  -- colonne dénormalisée du ticket ensuite.
  COALESCE(so.order_reference, t.order_reference)              AS edesk_order_reference,

  t.sales_order_id,
  l.ps_order_id,
  l.ps_order_reference,
  l.ps_order_state,
  l.match_rule                                                 AS order_match_rule,
  COALESCE(l.order_value_ttc, so.total_value, t.order_value)    AS order_value,

  -- Réfs produit : les vraies réfs PrestaShop si la commande est rattachée,
  -- sinon les SKU marketplace de la commande, sinon ceux du ticket.
  COALESCE(l.product_refs, so.order_refs, t.order_refs)        AS product_refs,

  l.product_names,
  (l.ps_order_id IS NOT NULL)                                  AS has_ps_order,

  -- Suivi de livraison : extrait du payload brut de la commande, déjà en base.
  -- Les colonnes du ticket ne sont écrites que par le sync eDesk ; lire le JSON
  -- rend les réponses "où est ma commande" opérantes sans attendre un run.
  -- Le numéro arrive entouré d'apostrophes en prod ("'000007092...'"),
  -- vraisemblablement un artefact d'export tableur côté marketplace : on nettoie,
  -- sinon il est inutilisable dans une réponse client.
  COALESCE(t.tracking_code, btrim(so.raw #>> '{tracking_codes,0,tracking_code}', '''" ')) AS tracking_code,
  COALESCE(t.carrier,     so.raw #>> '{tracking_codes,0,tracking_carrier_name}')          AS carrier,
  COALESCE(t.tracking_url, so.raw #>> '{tracking_codes,0,tracking_link}')                 AS tracking_url,
  COALESCE(t.shipped_at,  sav_try_timestamptz(so.raw ->> 'order_shipped_at'))             AS shipped_at,
  COALESCE(t.expected_delivery_from,
           sav_try_timestamptz(so.raw #>> '{sales_order_delivery_dates,expected_delivery_from}')) AS expected_delivery_from,
  COALESCE(t.expected_delivery_to,
           sav_try_timestamptz(so.raw #>> '{sales_order_delivery_dates,expected_delivery_to}'))   AS expected_delivery_to
FROM sav_tickets t
LEFT JOIN sav_sales_orders so ON so.id = t.sales_order_id
LEFT JOIN sav_order_link   l  ON l.sales_order_id = t.sales_order_id
LEFT JOIN sav_channel_map  cm ON cm.edesk_channel_id = t.channel_id;

CREATE INDEX IF NOT EXISTS idx_sav_tickets_sales_order ON sav_tickets (sales_order_id);
