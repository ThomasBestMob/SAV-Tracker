// GET /api/invoice?order_id=<id_order PrestaShop>
//
// Télécharge le PDF de facture d'une commande PrestaShop en pilotant le BO
// via HTTP pur (fetch), sans navigateur headless.
//
// Pourquoi pas le webservice : la ressource `order_invoices` de l'API REST
// n'expose que les métadonnées (numéro, date, montants) — pas le fichier. Le
// PDF n'est généré que par le contrôleur AdminPdf, qui exige une session BO.
// On simule la séquence login → fiche commande → lien PDF exactement comme le
// ferait un navigateur, mais avec fetch() : plus léger, compatible Vercel.
//
// Variables d'environnement requises :
//   PRESTASHOP_ADMIN_URL      ex: https://bestmobilier.com/admin_xxxxx
//   PRESTASHOP_ADMIN_EMAIL    compte employé dédié, sans double authentification
//   PRESTASHOP_ADMIN_PASSWORD

const ADMIN_URL    = (process.env.PRESTASHOP_ADMIN_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL  = process.env.PRESTASHOP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PRESTASHOP_ADMIN_PASSWORD;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// PrestaShop renvoie plusieurs Set-Cookie séparés. fetch() les concatène avec
// ", " dans headers.get() — ce qui casse le parsing si une valeur contient
// une virgule. On utilise getSetCookie() (Node 20 / WhatWG Fetch) qui renvoie
// un tableau propre, ou on fallback sur le split manuel.
function extractCookies(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/);
  return raw.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeJar(existing, incoming) {
  if (!incoming) return existing;
  const jar = Object.fromEntries(
    existing.split(';').map(p => p.trim().split('=')).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=')])
  );
  incoming.split(';').map(p => p.trim().split('=')).filter(p => p.length >= 2).forEach(([k, ...v]) => {
    jar[k.trim()] = v.join('=');
  });
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

export default async function handler(req, res) {
  const orderId = String(req.query.order_id || '').trim();
  if (!/^\d+$/.test(orderId)) {
    return res.status(400).json({ error: 'order_id (identifiant numérique PrestaShop) requis.' });
  }

  if (!ADMIN_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(501).json({
      error: 'Téléchargement facture non configuré : renseigner PRESTASHOP_ADMIN_URL, PRESTASHOP_ADMIN_EMAIL et PRESTASHOP_ADMIN_PASSWORD dans les variables Vercel (compte employé dédié, sans 2FA).',
    });
  }

  const debug = req.query.debug === '1';
  const log = [];

  try {
    // ── Étape 1 : page de login ───────────────────────────────────────────────
    const getRes = await fetch(`${ADMIN_URL}/index.php`, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    let jar = extractCookies(getRes.headers);
    const loginHtml = await getRes.text();
    log.push({ step: 'GET login', status: getRes.status, url: getRes.url, cookies: jar.length });

    // Le token PS est dans l'URL de la page de login (pas dans un champ caché) :
    // ?controller=AdminLogin&token=XXXX — il faut poster vers cette même URL.
    const urlTokenMatch = getRes.url.match(/[?&]token=([^&]+)/);
    const token = urlTokenMatch?.[1] ?? '';
    const loginPostUrl = token
      ? `${ADMIN_URL}/index.php?controller=AdminLogin&token=${token}`
      : `${ADMIN_URL}/index.php`;
    log.push({ step: 'token', found: !!token, length: token.length, postUrl: loginPostUrl });

    // ── Étape 2 : POST des identifiants ──────────────────────────────────────
    const postRes = await fetch(loginPostUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': jar,
        'User-Agent': UA,
        'Referer': `${ADMIN_URL}/index.php`,
        'Origin': new URL(ADMIN_URL).origin,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      body: new URLSearchParams({
        email: ADMIN_EMAIL,
        passwd: ADMIN_PASSWORD,
        submitLogin: '1',
        token,
      }).toString(),
      redirect: 'manual',
    });

    jar = mergeJar(jar, extractCookies(postRes.headers));
    const location = postRes.headers.get('location') || '';
    log.push({ step: 'POST login', status: postRes.status, location, cookies: jar.length });

    if (!location) {
      const body = await postRes.text().catch(() => '');
      log.push({ step: 'no redirect', bodySnippet: body.slice(0, 300) });
      if (debug) return res.status(200).json({ debug: log });
      if (body.includes('name="passwd"') || body.includes('id="login_form"')) {
        return res.status(502).json({ error: 'Connexion PS refusée (pas de redirection). Vérifier identifiants.' });
      }
    } else {
      const redir = location.startsWith('http') ? location : `${ADMIN_URL}${location.startsWith('/') ? '' : '/'}${location}`;
      const dashRes = await fetch(redir, {
        headers: { 'Cookie': jar, 'User-Agent': UA },
        redirect: 'follow',
      });
      jar = mergeJar(jar, extractCookies(dashRes.headers));
      const dashBody = await dashRes.text();
      log.push({ step: 'dashboard', status: dashRes.status, url: dashRes.url, hasPasswd: dashBody.includes('name="passwd"'), bodySnippet: dashBody.slice(0, 300) });

      if (dashBody.includes('name="passwd"') || dashBody.includes('id="login_form"')) {
        return res.status(502).json({
          error: 'Connexion au back-office PrestaShop refusée. Vérifier PRESTASHOP_ADMIN_EMAIL / _PASSWORD dans Vercel et que le compte n\'a pas de double authentification (2FA).',
        });
      }
    }

    // ── Étape 3 : fiche commande → URL de la facture ─────────────────────────
    const orderUrl = `${ADMIN_URL}/index.php?controller=AdminOrders&id_order=${orderId}&vieworder`;
    const orderRes = await fetch(orderUrl, {
      headers: { 'Cookie': jar, 'User-Agent': UA, 'Referer': `${ADMIN_URL}/index.php` },
      redirect: 'follow',
    });
    jar = mergeJar(jar, extractCookies(orderRes.headers));
    const orderHtml = await orderRes.text();

    // Le lien peut avoir des entités HTML (&amp;)
    const invoiceMatch = orderHtml.match(/href="([^"]*generateInvoicePDF[^"]*)"/i);

    // Cherche aussi des liens générique PDF pour diagnostic
    const allPdfLinks = [...orderHtml.matchAll(/href="([^"]*(?:PDF|pdf|facture|invoice)[^"]*)"/gi)]
      .map(m => m[1]).slice(0, 5);

    log.push({
      step: 'order page',
      status: orderRes.status,
      finalUrl: orderRes.url,
      hasPasswd: orderHtml.includes('name="passwd"'),
      invoiceFound: !!invoiceMatch,
      pdfLinksFound: allPdfLinks,
      bodySnippet: orderHtml.slice(0, 400),
    });

    if (!invoiceMatch) {
      if (debug) return res.status(200).json({ debug: log });
      if (orderHtml.includes('submitLogin') || orderHtml.includes('name="passwd"')) {
        return res.status(502).json({ error: 'Session BO expirée avant d\'atteindre la fiche commande.' });
      }
      return res.status(404).json({
        error: `Aucune facture disponible pour la commande PrestaShop #${orderId} — commande non facturée ou identifiant incorrect.`,
      });
    }
    if (debug) return res.status(200).json({ debug: log });

    let invoiceHref = invoiceMatch[1].replace(/&amp;/g, '&');
    if (!invoiceHref.startsWith('http')) {
      invoiceHref = `${ADMIN_URL}/${invoiceHref.replace(/^\//, '')}`;
    }

    // ── Étape 4 : téléchargement du PDF ──────────────────────────────────────
    const pdfRes = await fetch(invoiceHref, {
      headers: { 'Cookie': jar, 'User-Agent': UA },
      redirect: 'follow',
    });

    if (!pdfRes.ok) {
      return res.status(502).json({ error: `PrestaShop a répondu ${pdfRes.status} sur la génération du PDF.` });
    }

    const buffer = Buffer.from(await pdfRes.arrayBuffer());
    if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
      const preview = buffer.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ');
      return res.status(502).json({
        error: `La réponse n'est pas un PDF (session expirée ou PDF non généré). Début : ${preview}`,
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facture_${orderId}.pdf"`);
    return res.status(200).send(buffer);

  } catch (e) {
    return res.status(500).json({ error: `Erreur récupération facture : ${e.message}` });
  }
}
