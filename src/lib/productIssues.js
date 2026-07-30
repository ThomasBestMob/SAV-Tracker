/**
 * Taxonomie des défauts PRODUIT — axe distinct de la catégorie de ticket.
 *
 * src/lib/priority.js classe le ticket par nature de démarche (facture,
 * livraison, retour…) : c'est utile à l'équipe SAV, qui a besoin de savoir quel
 * geste faire. Ça ne dit rien à l'équipe offre, qui a besoin de savoir *ce qui
 * cloche sur le produit* : est-ce qu'il casse, est-ce qu'il s'affaisse, est-ce
 * que la couleur ne correspond pas aux photos.
 *
 * Les deux axes sont orthogonaux : un ticket "retour_remboursement" peut avoir
 * pour cause réelle un affaissement d'assise, et c'est cette cause qui doit
 * remonter à l'offre. Un ticket peut porter plusieurs défauts (une commande avec
 * une pièce manquante ET un panneau rayé) — on renvoie donc une liste, pas un
 * motif unique : forcer un seul motif ferait disparaître des signaux.
 *
 * Analyse le sujet ET le corps du premier message : le sujet des tickets
 * marketplace est souvent un libellé générique imposé par la plateforme
 * ("J'ai une question sur un produit"), toute l'information est dans le corps.
 */

export const PRODUCT_ISSUES = {
  casse_structure: {
    label: 'Casse / solidité',
    hint: 'Défaut de conception ou de matériau — le plus coûteux, à traiter en priorité',
    keywords: [
      'casse', 'cassee', 'casser', 'brise', 'brisee', 'fissure', 'fissuree', 'fendu', 'fendue',
      'se fend', 'effondre', 'effondree', 'plie', 'pliee', 'tordu', 'tordue', 'deforme',
      'pied casse', 'structure', 'armature', 'ne supporte pas', 'a cede', 'cede sous',
    ],
  },
  affaissement_confort: {
    label: 'Confort / affaissement',
    hint: 'Mousse ou suspension sous-dimensionnée — signal fort sur la qualité perçue',
    keywords: [
      'affaisse', 'affaissee', 'affaissement', 's affaisse', 'inconfortable', 'trop dur',
      'trop mou', 'trop moue', 'trop ferme', 'pas confortable', 'mal au dos', 'assise',
      'mousse', 'perd sa forme', 'se creuse', 'creux',
    ],
  },
  piece_manquante: {
    label: 'Pièce manquante',
    hint: 'Défaut de conditionnement — corrigeable en amont, gain rapide',
    keywords: [
      'piece manquante', 'pieces manquantes', 'il manque', 'manque une', 'manque des',
      'manquant', 'manquante', 'incomplet', 'incomplete', 'vis manquante', 'sans notice',
      'pas recu toutes', 'colis incomplet',
    ],
  },
  montage: {
    label: 'Montage / notice',
    hint: 'Notice ou pré-perçages défaillants — cause fréquente de retours évitables',
    keywords: [
      'montage', 'monter', 'notice', 'instructions', 'mode d emploi', 'trous', 'percage',
      'pre perce', 'mal perce', 'ne s aligne pas', 'ne correspond pas aux trous',
      'impossible a monter', 'visserie', 'boulons', 'chevilles',
    ],
  },
  conformite_visuelle: {
    label: 'Couleur / aspect vs photo',
    hint: 'Écart entre la fiche produit et le réel — corriger visuels ou description',
    keywords: [
      'couleur', 'teinte', 'nuance', 'pas la meme couleur', 'different de la photo',
      'pas comme sur la photo', 'pas conforme a la photo', 'aspect', 'matiere differente',
      'plus fonce', 'plus clair', 'rien a voir avec la photo',
    ],
  },
  dimensions: {
    label: 'Dimensions',
    hint: 'Fiche produit imprécise — vérifier les cotes annoncées',
    keywords: [
      'dimensions', 'dimension', 'trop grand', 'trop petit', 'trop large', 'trop etroit',
      'ne rentre pas', 'ne passe pas', 'mesure', 'hauteur', 'largeur', 'profondeur',
      'pas les bonnes dimensions',
    ],
  },
  finition: {
    label: 'Finition / rayures',
    hint: 'Contrôle qualité fournisseur insuffisant',
    keywords: [
      'finition', 'finitions', 'rayure', 'rayures', 'raye', 'rayee', 'tache', 'taches',
      'mal fini', 'bavure', 'peinture', 'vernis', 'ecaille', 'ecaillee', 'coup',
    ],
  },
  revetement: {
    label: 'Tissu / revêtement',
    hint: 'Qualité de matière — impacte la durabilité perçue',
    keywords: [
      'tissu', 'housse', 'cuir', 'simili', 'velours', 'se dechire', 'dechire', 'decousu',
      'couture', 'coutures', 'bouloche', 'peluche', 'se detend', 'tache le',
    ],
  },
  odeur: {
    label: 'Odeur',
    hint: 'Émissions de COV — risque réglementaire et avis négatifs',
    keywords: ['odeur', 'odeurs', 'sent mauvais', 'sent fort', 'chimique', 'produit chimique', 'puanteur'],
  },
  bruit: {
    label: 'Bruit / grincement',
    hint: 'Assemblage ou quincaillerie — motif récurrent d\'insatisfaction à l\'usage',
    keywords: ['grince', 'grincement', 'grincements', 'bruit', 'bruyant', 'craquement', 'craque quand'],
  },
  arrive_abime: {
    label: 'Arrivé abîmé (transport)',
    hint: 'Emballage ou transporteur — à distinguer d\'un défaut produit',
    keywords: [
      'colis abime', 'abime', 'abimee', 'endommage', 'endommagee', 'carton abime',
      'arrive casse', 'casse a la livraison', 'enfonce', 'choc', 'emballage',
    ],
  },
  non_conforme: {
    label: 'Produit non conforme',
    hint: 'Erreur de préparation ou de référencement',
    keywords: [
      'pas le bon produit', 'mauvais produit', 'produit different', 'autre produit',
      'erreur de reference', 'ce n est pas ce que j ai commande', 'pas ce que j avais commande',
      'mauvaise reference', 'mauvais article',
    ],
  },
};

/** Retire les accents : les clients écrivent souvent sans, l'appariement doit y survivre. */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Défauts produit détectés, du plus au moins probable.
 * @returns {string[]} clés de PRODUCT_ISSUES (vide si rien de produit détecté)
 */
export function detectProductIssues(subject, body) {
  // Le sujet compte double : quand il est explicite ("pied cassé"), c'est le
  // signal le plus fiable. Mais il est souvent génériqué par la marketplace,
  // d'où l'analyse du corps qui porte le vrai contenu.
  const hay = `${normalize(subject)} ${normalize(subject)} ${normalize(body)}`;
  if (!hay.trim()) return [];

  const scored = [];
  for (const [key, def] of Object.entries(PRODUCT_ISSUES)) {
    let hits = 0;
    for (const kw of def.keywords) {
      if (hay.includes(normalize(kw))) hits += 1;
    }
    if (hits > 0) scored.push({ key, hits });
  }
  return scored.sort((a, b) => b.hits - a.hits).map((s) => s.key);
}

export function productIssueLabel(key) {
  return PRODUCT_ISSUES[key]?.label || key;
}

export function productIssueHint(key) {
  return PRODUCT_ISSUES[key]?.hint || null;
}

export const PRODUCT_ISSUE_KEYS = Object.keys(PRODUCT_ISSUES);
