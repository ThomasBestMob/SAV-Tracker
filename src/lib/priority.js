/**
 * Moteur de classification + priorisation des tickets SAV.
 *
 * Opère sur la forme NORMALISÉE stockée dans sav_tickets (pas sur le payload
 * brut eDesk) : ça découple ce moteur du schéma exact de l'API, qui n'a pas pu
 * être vérifié en détail sans jeton réel (cf. README). Un seul point à ajuster
 * si le mapping des champs change : sync/edesk_sync.js.
 *
 * Utilisé à la fois côté sync (Node, calcul au moment de l'écriture en base)
 * et côté front (recalcul live si besoin, ex. filtre "critique uniquement").
 */

// ── Classification ──────────────────────────────────────────────────

const CATEGORY_KEYWORDS = {
  facture: [
    'facture', 'invoice', 'devis', 'attestation', 'justificatif',
  ],
  livraison: [
    'livraison', 'colis', 'retard', 'delivery', 'shipping', 'transporteur',
    'suivi', 'tracking', 'non reçu', 'non livré', 'perdu',
  ],
  produit_defectueux: [
    'cassé', 'défectueux', 'panne', 'ne fonctionne pas', 'abîmé', 'endommagé',
    'manquant', 'pièce manquante', 'défaut', 'defective', 'broken', 'sav',
  ],
  retour_remboursement: [
    'retour', 'rembours', 'annuler', 'annulation', 'refund', 'return',
    'rétractation', 'renvoi',
  ],
  info_produit: [
    'dimension', 'couleur', 'disponib', 'délai de livraison estimé',
    'question', 'renseignement', 'compatib',
  ],
  reclamation_qualite: [
    'insatisf', 'mécontent', 'scandaleux', 'inadmissible', 'plainte',
    'réclamation', 'complaint', 'déçu', 'qualité',
  ],
};

// Tags eDesk connus -> catégorie (à compléter une fois les vrais libellés de
// tags observés en prod ; le fallback mots-clés couvre en attendant).
const TAG_TO_CATEGORY = {
  invoice: 'facture',
  facture: 'facture',
  shipping: 'livraison',
  livraison: 'livraison',
  delivery: 'livraison',
  defective: 'produit_defectueux',
  return: 'retour_remboursement',
  refund: 'retour_remboursement',
  complaint: 'reclamation_qualite',
};

/** @param {{subject?:string, type?:string, tags?:string[]}} ticket */
export function classifyTicket(ticket) {
  const tags = (ticket.tags || []).map((t) => String(t).trim().toLowerCase());
  for (const tag of tags) {
    if (TAG_TO_CATEGORY[tag]) return TAG_TO_CATEGORY[tag];
  }

  const haystack = `${ticket.subject || ''} ${ticket.type || ''}`.toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const hits = keywords.reduce((n, kw) => (haystack.includes(kw) ? n + 1 : n), 0);
    if (hits > bestHits) { best = category; bestHits = hits; }
  }
  return best || 'autre';
}

// ── Priorisation ─────────────────────────────────────────────────────

// Poids canal : impacte la note vendeur / la conformité marketplace, donc un
// ticket en retard sur ces canaux est plus coûteux qu'un ticket site direct.
// Clé = nom de canal normalisé (minuscule) tel que stocké dans sav_channels.name
const CHANNEL_RISK_WEIGHT = {
  amazon: 1.3,
  cdiscount: 1.25,
  ebay: 1.2,
  manomano: 1.15,
  maisonsdumonde: 1.15,
  conforama: 1.1,
  laredoute: 1.1,
  but: 1.1,
  leroymerlin: 1.1,
  site: 1.0,
  'site internet': 1.0,
  default: 1.05,
};

// Sévérité inhérente par catégorie (0-1) — un défaut produit ou une réclamation
// qualité pèsent plus lourd qu'une simple question produit.
const CATEGORY_SEVERITY = {
  produit_defectueux: 0.9,
  reclamation_qualite: 0.85,
  retour_remboursement: 0.7,
  livraison: 0.6,
  facture: 0.35, // faible sévérité mais "quick win" — bonus séparé ci-dessous
  info_produit: 0.3,
  autre: 0.5,
};

// "Quick win" : demandes rapides à traiter (2 min chrono) qu'on a intérêt à
// clear en priorité pour désengorger la file, même si peu "graves" en soi.
const QUICK_WIN_CATEGORIES = new Set(['facture']);

const URGENCY_KEYWORDS = [
  'urgent', 'scandaleux', 'inadmissible', 'avocat', 'litige', 'immédiat',
  'immédiatement', 'dernier délai', 'signalement', 'urgence',
];

function ageHours(createdAt) {
  if (!createdAt) return 0;
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, ms / 3_600_000);
}

function channelWeight(channelName) {
  const key = String(channelName || '').trim().toLowerCase();
  return CHANNEL_RISK_WEIGHT[key] ?? CHANNEL_RISK_WEIGHT.default;
}

/**
 * @param {object} ticket - ligne normalisée sav_tickets
 *   { status, category, subject, created_at, last_message_at, message_count,
 *     order_value, channel_name, is_marketplace_review_at_risk }
 * @returns {{ score:number, level:'critique'|'haute'|'normale'|'basse', reasons:string[] }}
 */
export function computeTicketPriority(ticket) {
  if (!ticket) return { score: 0, level: 'basse', reasons: [] };
  const reasons = [];
  const status = String(ticket.status || '').toLowerCase();
  if (['closed', 'résolu', 'resolved', 'archived'].includes(status)) {
    return { score: 0, level: 'basse', reasons: ['Ticket clos'] };
  }

  const category = ticket.category || classifyTicket(ticket);
  const severity = CATEGORY_SEVERITY[category] ?? 0.5;
  let score = severity * 40; // base 0-40
  reasons.push(`Catégorie "${category}" (sévérité ${(severity * 100).toFixed(0)}%)`);

  // Âge du ticket (SLA) : monte vite les premières 24h, plafonne ensuite.
  const age = ageHours(ticket.last_message_at || ticket.created_at);
  const ageScore = Math.min(30, (age / 24) * 20); // ~20 pts à 24h, plafond 30 pts
  score += ageScore;
  if (age > 48) reasons.push(`Sans réponse depuis ${Math.round(age)}h — risque SLA`);
  else if (age > 24) reasons.push(`Ouvert depuis ${Math.round(age)}h`);

  // Risque canal (note vendeur / conformité marketplace)
  const chWeight = channelWeight(ticket.channel_name);
  score *= chWeight;
  if (chWeight > 1.1) reasons.push(`Canal à risque (${ticket.channel_name}) — impact note vendeur`);

  // Valeur de la commande liée (échelle log pour ne pas écraser le reste)
  const value = Number(ticket.order_value) || 0;
  if (value > 0) {
    const valueScore = Math.min(15, Math.log10(1 + value) * 6);
    score += valueScore;
    if (value >= 500) reasons.push(`Commande à forte valeur (${Math.round(value)} €)`);
  }

  // Mots-clés d'urgence dans le sujet
  const subject = String(ticket.subject || '').toLowerCase();
  const hasUrgentKeyword = URGENCY_KEYWORDS.some((kw) => subject.includes(kw));
  if (hasUrgentKeyword) {
    score += 15;
    reasons.push('Mot-clé d\'urgence détecté dans le sujet');
  }

  // Récidive : beaucoup de messages = client relance, escalade probable
  const msgCount = Number(ticket.message_count) || 0;
  if (msgCount >= 5) {
    score += 10;
    reasons.push(`${msgCount} messages échangés — relances multiples`);
  }

  // Quick win : bonus modéré pour vider vite les demandes rapides (facture...)
  if (QUICK_WIN_CATEGORIES.has(category)) {
    score += 8;
    reasons.push('Traitement rapide possible (quick win)');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let level = 'basse';
  if (score >= 70) level = 'critique';
  else if (score >= 45) level = 'haute';
  else if (score >= 20) level = 'normale';

  return { score, level, reasons };
}

export const CATEGORIES = Object.keys(CATEGORY_SEVERITY);
