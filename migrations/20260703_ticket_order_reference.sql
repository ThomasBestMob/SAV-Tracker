-- Dénormalise sav_sales_orders.order_reference sur sav_tickets, comme order_refs
-- (SKUs) l'est déjà. Nécessaire pour le bouton "Facture PDF" du front qui doit
-- appeler l'API PrestaShop avec la vraie référence commande (ex. "2605131521VS9EP"),
-- pas un SKU produit.
ALTER TABLE sav_tickets ADD COLUMN IF NOT EXISTS order_reference TEXT;
