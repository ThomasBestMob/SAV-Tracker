// GET /api/invoice?order_id=<id_order PrestaShop>
//
// Récupère le PDF de facture d'une commande PrestaShop.
//
// Pourquoi pas le webservice : la ressource `order_invoices` de l'API REST
// n'expose que les métadonnées de facture (numéro, date, montants) — pas le
// fichier. Le PDF n'est généré que par le contrôleur AdminPdf du back-office,
// qui exige une session employé authentifiée. On pilote donc un navigateur
// headless qui se connecte au BO et télécharge la facture.
//
// Ce chemin est volontairement isolé ici : il est plus fragile que le reste du
// produit (dépend du thème/version du BO, casse à chaque changement de login),
// et tout le reste du dashboard fonctionne sans lui.
//
// Variables d'environnement requises :
//   PRESTASHOP_ADMIN_URL    ex: https://bestmobilier.com/admin_xxxxx
//   PRESTASHOP_ADMIN_EMAIL  compte employé dédié, en lecture seule si possible
//   PRESTASHOP_ADMIN_PASSWORD

const ADMIN_URL = process.env.PRESTASHOP_ADMIN_URL;
const ADMIN_EMAIL = process.env.PRESTASHOP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PRESTASHOP_ADMIN_PASSWORD;

// ESM et non `module.exports` : package.json déclare "type": "module", donc ce
// fichier est chargé comme module ES. Avec module.exports, la fonction échouait
// dès le chargement ("module is not defined in ES module scope") — d'où une
// erreur générique côté front au lieu du message explicite prévu plus bas.
export default async function handler(req, res) {
  const orderId = String(req.query.order_id || '').trim();
  if (!/^\d+$/.test(orderId)) {
    return res.status(400).json({ error: 'order_id (id commande PrestaShop) requis.' });
  }

  if (!ADMIN_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(501).json({
      error:
        "Téléchargement facture non configuré : renseigner PRESTASHOP_ADMIN_URL, PRESTASHOP_ADMIN_EMAIL et PRESTASHOP_ADMIN_PASSWORD (compte employé dédié).",
    });
  }

  let browser;
  try {
    // Import paresseux : la dépendance est lourde et n'est utile que sur cette
    // route — les autres endpoints ne doivent pas la payer au démarrage.
    // En serverless (Vercel) le runtime n'embarque pas de navigateur : on
    // utilise le binaire fourni par @sparticuz/chromium. En local, Playwright
    // retombe sur le Chromium installé par `npx playwright install`.
    const { chromium } = await import('playwright-core');
    const sparticuz = await import('@sparticuz/chromium').then((m) => m.default).catch(() => null);
    browser = await chromium.launch(
      sparticuz
        ? { args: sparticuz.args, executablePath: await sparticuz.executablePath(), headless: true }
        : { headless: true }
    );
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(`${ADMIN_URL}/index.php`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="passwd"]', ADMIN_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('button[name="submitLogin"]'),
    ]);

    if (await page.locator('input[name="passwd"]').count()) {
      return res.status(502).json({ error: 'Connexion au back-office PrestaShop refusée (identifiants ou double authentification).' });
    }

    // Le token du contrôleur AdminPdf est propre à la session : on le récupère
    // depuis la fiche commande plutôt que de le coder en dur.
    await page.goto(`${ADMIN_URL}/index.php?controller=AdminOrders&id_order=${orderId}&vieworder`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const invoiceHref = await page
      .locator('a[href*="generateInvoicePDF"]')
      .first()
      .getAttribute('href')
      .catch(() => null);

    if (!invoiceHref) {
      return res.status(404).json({ error: `Aucune facture disponible pour la commande ${orderId} (pas encore facturée ?).` });
    }

    const cookies = await context.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const pdfUrl = invoiceHref.startsWith('http') ? invoiceHref : `${ADMIN_URL}/${invoiceHref.replace(/^\//, '')}`;

    const pdfRes = await fetch(pdfUrl, { headers: { Cookie: cookieHeader } });
    if (!pdfRes.ok) {
      return res.status(502).json({ error: `PrestaShop a répondu ${pdfRes.status} sur la génération du PDF.` });
    }

    const buffer = Buffer.from(await pdfRes.arrayBuffer());
    if (buffer.subarray(0, 4).toString() !== '%PDF') {
      // Session expirée ou redirection vers le login : mieux vaut une erreur
      // claire qu'un fichier corrompu envoyé au client final.
      return res.status(502).json({ error: 'La réponse PrestaShop n\'est pas un PDF (session expirée ?).' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facture_${orderId}.pdf"`);
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: `Échec de récupération de la facture : ${e.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
