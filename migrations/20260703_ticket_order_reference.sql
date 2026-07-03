-- Dénormalise sav_sales_orders.order_reference sur sav_tickets, comme order_refs
-- (SKUs) l'est déjà. Nécessaire pour le bouton "Facture PDF" du front qui doit
-- appeler l'API PrestaShop avec la vraie référence commande (ex. "2605131521VS9EP"),
-- pas un SKU produit.
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS order_reference TEXT;

-- Corps intégral du premier message du ticket (la plainte initiale du client),
-- récupéré via GET /messages/{id} sur eDesk. first_message_raw garde la
-- réponse brute pour pouvoir corriger l'extraction si le nom de champ deviné
-- pour le corps du message s'avère faux (cf. order_refs plus haut).
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS first_message_body TEXT;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS first_message_author TEXT;
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS first_message_raw JSONB;
