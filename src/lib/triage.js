/**
 * Moteur de triage opérationnel : à qui le tour, pour quand, et quoi faire.
 *
 * Remplace l'usage direct du score 0-100 (src/lib/priority.js) côté file de
 * traitement. Un score ne dit ni l'échéance ni le geste à faire : l'agent le
 * lit, hausse les épaules, et retourne dans eDesk. Ici on produit trois choses
 * lisibles sans formation :
 *   - une ÉCHÉANCE (SLA canal) -> l'ordre de traitement se justifie tout seul
 *   - une ACTION à faire       -> l'agent sait quoi faire avant d'ouvrir le ticket
 *   - le MATÉRIEL pour l'exécuter (n° de suivi, réponse pré-rédigée, facture)
 *
 * Calculé côté front, pas stocké : ces valeurs dépendent de l'heure courante et
 * seraient périmées dès l'écriture en base.
 */

// ── SLA par canal ────────────────────────────────────────────────────
// Délai de première réponse au-delà duquel le canal nous pénalise. Les
// marketplaces mesurent ce délai et le font entrer dans la santé du compte
// (Amazon est le plus strict), d'où des seuils plus courts que sur le site.
// Heures calendaires (pas ouvrées) : c'est ainsi que les marketplaces comptent.
const CHANNEL_SLA_HOURS = {
  amazon: 24,
  cdiscount: 24,
  manomano: 24,
  site: 24,
  laredoute: 48,
  conforama: 48,
  but: 48,
  maisonsdumonde: 48,
  leroymerlin: 48,
};
const DEFAULT_SLA_HOURS = 24;

export const CHANNEL_LABELS = {
  site: 'Site BestMobilier',
  cdiscount: 'Cdiscount',
  amazon: 'Amazon',
  laredoute: 'La Redoute',
  maisonsdumonde: 'Maisons du Monde',
  conforama: 'Conforama',
  but: 'BUT',
  manomano: 'ManoMano',
  leroymerlin: 'Leroy Merlin',
  autre: 'Autre / non rattaché',
};

export function channelLabel(key) {
  return CHANNEL_LABELS[key] || key || 'Inconnu';
}

export function slaHours(channelKey) {
  return CHANNEL_SLA_HOURS[channelKey] ?? DEFAULT_SLA_HOURS;
}

/**
 * Échéance de réponse. Le compteur part du dernier message du fil : c'est le
 * moment où la balle est repassée dans notre camp.
 */
export function computeSla(ticket, now = Date.now()) {
  const base = ticket.last_message_at || ticket.created_at;
  const hours = slaHours(ticket.channel_key);
  if (!base) return { hoursLeft: null, level: 'unknown', label: '—', deadline: null };

  // Le compteur SLA ne court que quand la main est chez nous. Sur un ticket où
  // nous avons répondu en dernier, afficher un dépassement serait faux : c'est
  // le client qui n'a pas donné suite.
  if (ticket.awaiting_us === false) {
    return { hoursLeft: null, level: 'waiting', label: 'En attente client', deadline: null };
  }

  const deadline = new Date(base).getTime() + hours * 3_600_000;
  const hoursLeft = (deadline - now) / 3_600_000;

  let level = 'ok';
  if (hoursLeft < 0) level = 'breached';
  else if (hoursLeft < 4) level = 'critical';
  else if (hoursLeft < 12) level = 'soon';

  const abs = Math.abs(hoursLeft);
  const amount = abs < 1 ? `${Math.round(abs * 60)} min` : abs < 48 ? `${Math.round(abs)} h` : `${Math.round(abs / 24)} j`;
  const label = hoursLeft < 0 ? `Hors délai depuis ${amount}` : `À traiter sous ${amount}`;

  return { hoursLeft, level, label, deadline: new Date(deadline) };
}

// ── Actions ──────────────────────────────────────────────────────────
// `automatable` = le matériel de réponse est déjà disponible sans recherche
// manuelle : ce sont ces tickets qui alimentent l'onglet Automatisations.

export const ACTIONS = {
  envoyer_facture: { label: 'Envoyer la facture', automatable: true, tone: 'accent' },
  repondre_suivi: { label: 'Répondre suivi colis', automatable: true, tone: 'accent' },
  escalader_transporteur: { label: 'Escalader au transporteur', automatable: false, tone: 'urgent' },
  rattacher_commande: { label: 'Retrouver la commande', automatable: false, tone: 'warn' },
  traiter_sav_piece: { label: 'Traiter SAV / pièce', automatable: false, tone: 'urgent' },
  traiter_retour: { label: 'Traiter retour / remboursement', automatable: false, tone: 'warn' },
  repondre: { label: 'Répondre au client', automatable: false, tone: 'neutral' },
};

function isLate(ticket, now) {
  if (!ticket.expected_delivery_to) return false;
  return new Date(ticket.expected_delivery_to).getTime() < now;
}

/**
 * Action à faire sur ce ticket, déduite de la catégorie ET du matériel
 * disponible : une demande de facture sans commande rattachée n'est pas la même
 * tâche qu'une demande de facture prête à envoyer.
 */
export function suggestAction(ticket, now = Date.now()) {
  const cat = ticket.category;
  const hasOrder = !!ticket.ps_order_id;
  const hasTracking = !!ticket.tracking_code;

  if (cat === 'facture') return hasOrder ? 'envoyer_facture' : 'rattacher_commande';

  if (cat === 'livraison') {
    if (hasTracking && isLate(ticket, now)) return 'escalader_transporteur';
    if (hasTracking) return 'repondre_suivi';
    return hasOrder ? 'repondre' : 'rattacher_commande';
  }

  if (cat === 'produit_defectueux') return 'traiter_sav_piece';
  if (cat === 'retour_remboursement') return 'traiter_retour';
  return 'repondre';
}

// ── Raisons lisibles ─────────────────────────────────────────────────
// Remplace priority_reasons (qui explique un score) par des faits que l'agent
// peut vérifier d'un coup d'œil.

export function triageReasons(ticket, sla, now = Date.now()) {
  const out = [];
  if (sla.level === 'breached') out.push(`SLA ${channelLabel(ticket.channel_key)} dépassé`);
  else if (sla.level === 'critical') out.push(`SLA ${channelLabel(ticket.channel_key)} dans ${Math.round(sla.hoursLeft)} h`);

  const msg = Number(ticket.message_count) || 0;
  if (msg >= 5) out.push(`${msg} messages — le client relance`);

  const value = Number(ticket.order_value) || 0;
  if (value >= 500) out.push(`Commande ${Math.round(value)} €`);

  if (isLate(ticket, now) && ticket.expected_delivery_to) {
    const days = Math.round((now - new Date(ticket.expected_delivery_to).getTime()) / 86_400_000);
    out.push(`Livraison en retard de ${days} j`);
  }

  if (!ticket.ps_order_id && ticket.edesk_order_reference) out.push('Commande non rattachée à PrestaShop');
  return out;
}

// ── État du fil ──────────────────────────────────────────────────────
// Ce qui rend la file utilisable au quotidien : savoir de quoi l'agent est
// réellement responsable maintenant. Une liste qui mélange "le client attend ma
// réponse" et "j'ai répondu, j'attends le client" ne peut pas être vidée, donc
// ne se travaille pas.

export const BUCKETS = {
  a_traiter: { label: 'À traiter', hint: 'Le client attend notre réponse' },
  en_attente_client: { label: 'En attente client', hint: 'Nous avons répondu en dernier' },
  notification: { label: 'Notifications', hint: 'Mails transactionnels envoyés par nous, pas des demandes' },
};

export function bucketOf(ticket) {
  if (!ticket.is_customer_request) return 'notification';
  return ticket.awaiting_us ? 'a_traiter' : 'en_attente_client';
}

/** Enrichit un ticket de sav_ticket_enriched avec son triage. */
export function triage(ticket, now = Date.now()) {
  const sla = computeSla(ticket, now);
  const action = suggestAction(ticket, now);
  return {
    ...ticket,
    sla,
    action,
    actionMeta: ACTIONS[action],
    bucket: bucketOf(ticket),
    reasons: triageReasons(ticket, sla, now),
  };
}

/** Tri de la file : ce qui va cramer en premier. */
export function bySlaUrgency(a, b) {
  const av = a.sla.hoursLeft ?? Infinity;
  const bv = b.sla.hoursLeft ?? Infinity;
  return av - bv;
}

// ── Matériel de réponse ──────────────────────────────────────────────

// L'URL de suivi renvoyée par eDesk est une simple recherche Google : on
// reconstruit le lien du transporteur quand on le reconnaît, sinon on garde le
// lien d'origine plutôt que rien.
const CARRIER_TRACKING_URLS = {
  colissimo: (t) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${t}`,
  chronopost: (t) => `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${t}`,
  dpd: (t) => `https://www.dpd.fr/trace/${t}`,
  gls: (t) => `https://gls-group.com/FR/fr/suivi-colis?match=${t}`,
  ups: (t) => `https://www.ups.com/track?tracknum=${t}`,
  dhl: (t) => `https://www.dhl.com/fr-fr/home/tracking.html?tracking-id=${t}`,
  geodis: (t) => `https://www.geodis.com/fr/suivi-de-colis?reference=${t}`,
  xpo: (t) => `https://www.xpo.com/track/?reference=${t}`,
  dachser: (t) => `https://elogistics.dachser.com/shp2s/?shipmentNumber=${t}`,
};

export function trackingUrl(ticket) {
  const carrier = String(ticket.carrier || '').toLowerCase().replace(/[^a-z]/g, '');
  const code = ticket.tracking_code;
  if (!code) return null;
  for (const [key, build] of Object.entries(CARRIER_TRACKING_URLS)) {
    if (carrier.includes(key)) return build(encodeURIComponent(code));
  }
  return ticket.tracking_url || null;
}

function formatDate(d) {
  return d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : null;
}

/**
 * Réponse pré-rédigée pour les cas outillés. L'agent la relit et l'envoie —
 * jamais d'envoi sans relecture (cf. README, section Automatisations).
 */
// Détecte si le message est un relais marketplace (Cdiscount, Amazon…)
// en cherchant leur signature dans le corps ou le sujet du ticket.
function detectMarketplaceRelay(ticket) {
  const hay = `${ticket.subject || ''} ${ticket.first_message_body || ''}`.toLowerCase();
  if (hay.includes('cdiscount') || hay.includes('service client cdiscount')) return 'Cdiscount';
  if (hay.includes('amazon') || hay.includes('marketplace amazon')) return 'Amazon';
  if (hay.includes('manomano') || hay.includes('mano mano')) return 'ManoMano';
  if (hay.includes('maisons du monde') || hay.includes('maisonsdumonde')) return 'Maisons du Monde';
  if (hay.includes('la redoute')) return 'La Redoute';
  if (hay.includes('conforama')) return 'Conforama';
  if (hay.includes('but.fr') || /\bbut\b/.test(hay)) return 'BUT';
  return null;
}

export function draftReply(ticket) {
  const action = suggestAction(ticket);
  const ref = ticket.edesk_order_reference || ticket.ps_order_reference || '';
  const marketplace = detectMarketplaceRelay(ticket);

  if (marketplace && !ticket.channel_key?.includes(marketplace.toLowerCase().replace(/ /g, ''))) {
    return [
      'Bonjour,',
      '',
      `Nous avons bien reçu votre demande transmise via ${marketplace}.`,
      ref ? `Nous la rattachons à votre commande ${ref}.` : '',
      '',
      'Nous revenons vers vous dans les meilleurs délais.',
      '',
      'Bien cordialement,',
      'Le service client BestMobilier',
    ].filter(s => s !== undefined).join('\n');
  }

  if (action === 'repondre_suivi') {
    const from = formatDate(ticket.expected_delivery_from);
    const to = formatDate(ticket.expected_delivery_to);
    const window = from && to ? `entre le ${from} et le ${to}` : to ? `d'ici le ${to}` : 'sous peu';
    const url = trackingUrl(ticket);
    return [
      'Bonjour,',
      '',
      `Votre commande ${ref} a bien été expédiée${ticket.carrier ? ` via ${ticket.carrier}` : ''}.`,
      `Numéro de suivi : ${ticket.tracking_code}`,
      url ? `Suivi en ligne : ${url}` : null,
      '',
      `La livraison est prévue ${window}.`,
      '',
      'Bien cordialement,',
      'Le service client BestMobilier',
    ].filter(Boolean).join('\n');
  }

  if (action === 'escalader_transporteur') {
    const to = formatDate(ticket.expected_delivery_to);
    return [
      'Bonjour,',
      '',
      `Votre commande ${ref} devait être livrée ${to ? `le ${to}` : 'ces derniers jours'} et ne l'a pas été — nous en sommes sincèrement désolés.`,
      `Nous ouvrons immédiatement une enquête auprès de ${ticket.carrier || 'notre transporteur'} (suivi ${ticket.tracking_code || '—'}) et revenons vers vous sous 48 h avec une solution.`,
      '',
      'Bien cordialement,',
      'Le service client BestMobilier',
    ].join('\n');
  }

  if (action === 'envoyer_facture') {
    return [
      'Bonjour,',
      '',
      `Vous trouverez ci-joint la facture de votre commande ${ref}.`,
      '',
      'Bien cordialement,',
      'Le service client BestMobilier',
    ].join('\n');
  }

  return null;
}
