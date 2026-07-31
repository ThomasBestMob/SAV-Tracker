// Nettoie le HTML des corps de messages eDesk pour affichage en texte brut.
// eDesk renvoie du HTML avec entités encodées (&apos; &amp; etc.) et balises
// de mise en forme (<div>, <br>, <li>...) que le composant React afficherait
// littéralement si on ne les strip pas.
export function stripHtml(html) {
  if (!html) return '';
  return html
    // Entités HTML courantes
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Balises bloc → saut de ligne
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th)[^>]*>/gi, '\n')
    // Toutes les autres balises → supprimées
    .replace(/<[^>]+>/g, '')
    // Lignes vides consécutives → max 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
