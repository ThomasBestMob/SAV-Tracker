export function Stat({ label, value, sub, accent = false, urgent = false }) {
  return (
    <div className={`border-l-2 pl-4 py-1 ${urgent ? 'border-urgent/40' : 'border-ink/15'}`}>
      <div className="text-[10px] uppercase tracking-widest text-muted mb-1">{label}</div>
      <div className={`num text-3xl font-medium ${urgent ? 'text-urgent' : accent ? 'text-accent' : 'text-ink'}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

export function SectionTitle({ kicker, title, byline }) {
  return (
    <div className="mb-6 flex items-baseline justify-between flex-wrap gap-2">
      <div>
        {kicker && <div className="text-[10px] uppercase tracking-widest text-accent mb-1">{kicker}</div>}
        <h2 className="font-display text-3xl font-medium tracking-tight">{title}</h2>
      </div>
      {byline && <div className="text-xs text-muted font-mono">{byline}</div>}
    </div>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`bg-warm/40 border border-ink/8 p-6 ${className}`}>
      {children}
    </div>
  );
}

export function Empty({ message = 'Aucune donnée disponible.' }) {
  return (
    <div className="text-sm text-muted italic py-12 text-center">{message}</div>
  );
}

export function Loading() {
  return (
    <div className="text-xs text-muted uppercase tracking-widest py-8">Chargement…</div>
  );
}

const PRIORITY_STYLES = {
  critique: 'bg-urgent/10 text-urgent border-urgent/30',
  haute: 'bg-orange-100 text-orange-700 border-orange-300',
  normale: 'bg-ink/5 text-ink/70 border-ink/15',
  basse: 'bg-ink/5 text-muted border-ink/10',
};

export function PriorityBadge({ level }) {
  const cls = PRIORITY_STYLES[level] || PRIORITY_STYLES.normale;
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium border rounded-sm ${cls}`}>
      {level || 'normale'}
    </span>
  );
}

const CATEGORY_LABELS = {
  facture: 'Facture',
  livraison: 'Livraison',
  produit_defectueux: 'Produit défectueux',
  retour_remboursement: 'Retour / Remboursement',
  info_produit: 'Info produit',
  reclamation_qualite: 'Réclamation qualité',
  autre: 'Autre',
};

export function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || 'Autre';
}

export function CategoryPill({ category }) {
  return (
    <span className="inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium bg-accent/10 text-accent rounded-sm">
      {categoryLabel(category)}
    </span>
  );
}
