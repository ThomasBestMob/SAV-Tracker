-- ══════════════════════════════════════════════════════════════════════
-- v2.1 — trois corrections issues du premier usage réel :
--
-- 1. Les tickets clos n'étaient pas filtrés. Le front testait `status <> 'closed'`
--    alors qu'eDesk renvoie ses valeurs en PascalCase (cf. "OrderShipped" sur les
--    commandes) : tout l'historique restait dans la file, d'où "hors délai depuis
--    29 j" partout et 0 % de respect SLA. Le test devient insensible à la casse
--    et centralisé dans la vue.
--
-- 2. Rien ne distinguait "en attente de nous" de "en attente du client". Une file
--    qui liste les deux n'est pas une file de travail : l'agent ne peut pas la
--    vider. Le sens du fil vient du dernier message.
--
-- 3. eDesk ingère aussi nos propres mails transactionnels ("[Best Mobilier]
--    Paiement accepté") comme des tickets. Un fil dont le PREMIER message sort de
--    chez nous n'est pas une demande client : on le sort de la file.
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS first_message_at        TIMESTAMPTZ;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS first_message_direction TEXT;  -- inbound | outbound
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS last_message_direction  TEXT;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS product_issues          TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_sav_tickets_product_issues ON sav_tickets USING GIN (product_issues);

DROP VIEW IF EXISTS sav_product_issue_stats;
DROP VIEW IF EXISTS sav_product_stats;
DROP VIEW IF EXISTS sav_channel_stats;
DROP VIEW IF EXISTS sav_ticket_enriched;

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
  t.first_message_at,
  t.first_message_direction,
  t.last_message_direction,
  t.product_issues,

  -- Ouvert : tout ce qui n'est pas explicitement terminé. Liste en dur plutôt
  -- qu'un test d'égalité, pour couvrir les variantes de casse et de langue.
  (lower(COALESCE(t.status, '')) NOT IN (
     'closed', 'close', 'resolved', 'resolve', 'archived', 'archive',
     'spam', 'trash', 'deleted', 'ferme', 'fermé', 'resolu', 'résolu'
   )) AS is_open,

  -- La main est chez nous si le dernier message vient du client. Quand la
  -- direction est inconnue (ticket pas encore resynchronisé), on considère que
  -- la main est chez nous : mieux vaut un ticket à vérifier en trop qu'une
  -- demande client oubliée.
  (COALESCE(t.last_message_direction, 'inbound') = 'inbound') AS awaiting_us,

  -- Demande client authentique : exclut nos propres notifications
  -- transactionnelles, que le premier message trahit (il sort de chez nous).
  (COALESCE(t.first_message_direction, 'inbound') = 'inbound') AS is_customer_request,

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
-- Stats produit — inchangées dans leur principe, mais restreintes aux vraies
-- demandes clients (hors notifications transactionnelles) pour ne pas gonfler
-- artificiellement le taux de SAV.
-- ══════════════════════════════════════════════════════════════════════
CREATE VIEW sav_product_stats AS
WITH tickets_by_ref AS (
  SELECT unnest(e.product_refs) AS product_ref, e.id AS ticket_id, e.category, e.created_at
  FROM sav_ticket_enriched e
  WHERE e.product_refs IS NOT NULL
    AND array_length(e.product_refs, 1) > 0
    AND e.is_customer_request
),
tickets_90j AS (
  SELECT product_ref,
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
-- Défauts produit par référence — la vue que lit l'équipe offre.
-- Un ticket peut porter plusieurs défauts, donc la somme des lignes d'une réf
-- dépasse son nombre de tickets : c'est voulu, chaque défaut compte pour lui.
-- ══════════════════════════════════════════════════════════════════════
CREATE VIEW sav_product_issue_stats AS
WITH exploded AS (
  -- CROSS JOIN LATERAL et non deux unnest() dans la liste de SELECT : depuis
  -- PostgreSQL 10, plusieurs unnest() en liste de sortie s'expandent en
  -- parallèle (la plus courte complétée de NULL), pas en produit cartésien —
  -- une commande à 2 réfs et 3 défauts perdrait des croisements.
  SELECT
    pr.product_ref,
    pi.issue,
    e.id AS ticket_id,
    e.created_at
  FROM sav_ticket_enriched e
  CROSS JOIN LATERAL unnest(e.product_refs)   AS pr(product_ref)
  CROSS JOIN LATERAL unnest(e.product_issues) AS pi(issue)
  WHERE e.product_refs IS NOT NULL
    AND array_length(e.product_refs, 1) > 0
    AND e.product_issues IS NOT NULL
    AND array_length(e.product_issues, 1) > 0
    AND e.is_customer_request
    AND e.created_at >= NOW() - INTERVAL '180 days'
),
agg AS (
  SELECT product_ref, issue,
         COUNT(DISTINCT ticket_id) AS nb_tickets,
         MAX(created_at)           AS dernier_ticket_at
  FROM exploded
  GROUP BY product_ref, issue
),
ventes AS (
  SELECT product_ref, SUM(quantity) AS nb_ventes, MAX(product_name) AS product_name
  FROM ps_sales_daily
  WHERE sale_date >= (CURRENT_DATE - INTERVAL '180 days')
  GROUP BY product_ref
)
SELECT
  a.product_ref,
  v.product_name,
  a.issue,
  a.nb_tickets,
  a.dernier_ticket_at,
  COALESCE(v.nb_ventes, 0) AS nb_ventes_180j,
  CASE WHEN COALESCE(v.nb_ventes, 0) > 0
       THEN ROUND(a.nb_tickets::NUMERIC / v.nb_ventes * 100, 2)
       ELSE NULL
  END AS taux_pct
FROM agg a
LEFT JOIN ventes v ON v.product_ref = a.product_ref;

-- ══════════════════════════════════════════════════════════════════════
-- Taux de contact par canal — restreint aux vraies demandes clients.
-- ══════════════════════════════════════════════════════════════════════
CREATE VIEW sav_channel_stats AS
WITH tickets AS (
  SELECT channel_key, COUNT(*) AS nb_tickets,
         MODE() WITHIN GROUP (ORDER BY category) AS top_category
  FROM sav_ticket_enriched
  WHERE created_at >= NOW() - INTERVAL '30 days' AND is_customer_request
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

GRANT SELECT ON sav_ticket_enriched      TO anon, authenticated;
GRANT SELECT ON sav_product_stats        TO anon, authenticated;
GRANT SELECT ON sav_product_issue_stats  TO anon, authenticated;
GRANT SELECT ON sav_channel_stats        TO anon, authenticated;
