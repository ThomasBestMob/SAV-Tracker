// GET /api/invoice?order_ref=...
//
// TODO (v2) : brancher sur l'API webservice PrestaShop, ressource `order_invoices`
// (télécharger le PDF via /api/order_invoices/{id}?deferred_download ou l'endpoint
// équivalent selon la version PrestaShop). Nécessite d'ajouter cette ressource aux
// permissions de la clé webservice PRESTASHOP_API_URL/PRESTASHOP_API_KEY (même clé
// que marketplace-tracker, ou une clé dédiée en lecture seule sur order_invoices).
//
// Pour l'instant : renvoie une erreur claire plutôt qu'un crash, pour que le bouton
// "Facture PDF" du front reste fonctionnel dès que cette ressource sera branchée.

module.exports = async function handler(req, res) {
  const orderRef = req.query.order_ref;
  if (!orderRef) return res.status(400).json({ error: 'order_ref requis' });

  const PS_URL = process.env.PRESTASHOP_API_URL;
  const PS_KEY = process.env.PRESTASHOP_API_KEY;
  if (!PS_URL || !PS_KEY) {
    return res.status(501).json({
      error: "Téléchargement facture pas encore configuré : PRESTASHOP_API_URL / PRESTASHOP_API_KEY manquants, et la ressource 'order_invoices' doit être autorisée sur la clé webservice (Prestashop BO > Paramètres avancés > Webservice).",
    });
  }

  return res.status(501).json({
    error: "Intégration order_invoices à implémenter (TODO v2) — voir commentaire en tête de api/invoice.js.",
  });
};
