import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Card, SectionTitle, Loading, Empty, categoryLabel } from '../components/Atoms';
import { channelLabel } from '../lib/triage';

const MIN_VENTES = 10;

const CATEGORY_COLORS = {
  facture: '#1d5fae',
  livraison: '#c8401c',
  produit_defectueux: '#a3252c',
  retour_remboursement: '#b8860b',
  info_produit: '#4a7a4a',
  reclamation_qualite: '#6b3fa0',
  autre: '#6b6863',
};

function ProductWheel({ refId, breakdown }) {
  const total = breakdown.reduce((s, b) => s + b.count, 0) || 1;
  const size = 320;
  const center = size / 2;
  const radius = 108;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[320px] mx-auto">
      {breakdown.map((b, i) => {
        const angle = (i / breakdown.length) * 2 * Math.PI - Math.PI / 2;
        const x = center + radius * Math.cos(angle);
        const y = center + radius * Math.sin(angle);
        const r = 16 + (b.count / total) * 36;
        const color = CATEGORY_COLORS[b.category] || CATEGORY_COLORS.autre;
        return (
          <g key={b.category}>
            <line x1={center} y1={center} x2={x} y2={y} stroke={color} strokeOpacity={0.25} strokeWidth={2} />
            <circle cx={x} cy={y} r={r} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1.5} />
            <text x={x} y={y - 2} textAnchor="middle" className="text-[13px] font-mono font-medium" fill={color}>{b.count}</text>
            <text x={x} y={y + 12} textAnchor="middle" className="text-[8px] uppercase tracking-wider" fill="#6b6863">
              {categoryLabel(b.category)}
            </text>
          </g>
        );
      })}
      <circle cx={center} cy={center} r={38} fill="#0a0a0a" />
      <text x={center} y={center - 3} textAnchor="middle" className="text-[13px] font-mono font-medium" fill="#fafaf7">{refId}</text>
      <text x={center} y={center + 12} textAnchor="middle" className="text-[8px] uppercase tracking-wider" fill="#fafaf7" opacity={0.7}>{total} ticket{total > 1 ? 's' : ''}</text>
    </svg>
  );
}

export default function Products({ period }) {
  const [stats, setStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedRef, setSelectedRef] = useState(null);
  const [detailTickets, setDetailTickets] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    // Seuil de ventes : sans lui le classement remonte des références à 1 vente
    // / 1 ticket affichées à 100 % de SAV, qui écrasent les vraies anomalies.
    supabase
      .from('sav_product_stats')
      .select('*')
      .not('nb_tickets_90j', 'eq', 0)
      .gte('nb_ventes_90j', MIN_VENTES)
      .order('taux_sav_pct', { ascending: false, nullsFirst: false })
      .limit(200)
      .then(({ data, error }) => {
        if (!error && data) setStats(data);
        setLoading(false);
      });
  }, [period]);

  const top50 = useMemo(() => stats.slice(0, 50), [stats]);

  const searchResult = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.trim().toLowerCase();
    return stats.find((s) => s.product_ref.toLowerCase() === q)
      || stats.find((s) => s.product_ref.toLowerCase().includes(q))
      || null;
  }, [search, stats]);

  async function openDetail(ref) {
    setSelectedRef(ref);
    setDetailLoading(true);
    setDetailTickets(null);
    const { data, error } = await supabase
      .from('sav_ticket_enriched')
      .select('id,subject,category,status,created_at,product_refs,channel_key,first_message_body,edesk_order_reference')
      .contains('product_refs', [ref])
      .order('created_at', { ascending: false })
      .limit(100);
    if (!error && data) setDetailTickets(data);
    setDetailLoading(false);
  }

  const breakdown = useMemo(() => {
    if (!detailTickets) return [];
    const byCat = {};
    detailTickets.forEach((t) => { byCat[t.category || 'autre'] = (byCat[t.category || 'autre'] || 0) + 1; });
    return Object.entries(byCat)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [detailTickets]);

  return (
    <div className="space-y-10">
      <div>
        <SectionTitle kicker="Recherche" title="Taux de SAV par référence" byline="90 derniers jours · tickets / ventes" />
        <div className="flex gap-3 max-w-lg">
          <input
            type="text"
            placeholder="Réf parent ou enfant — ex: 1366BEI"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent border border-ink/20 px-4 py-2.5 text-sm focus:outline-none focus:border-accent font-mono"
          />
        </div>
        {searchResult && (
          <Card className="mt-4 flex flex-col md:flex-row gap-6 items-center">
            <div className="flex-1 w-full">
              <div className="text-2xl font-display font-medium">{searchResult.product_ref}</div>
              <div className="mt-3 grid grid-cols-3 gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted">Taux SAV</div>
                  <div className="num text-2xl font-medium text-accent">
                    {searchResult.taux_sav_pct != null ? `${searchResult.taux_sav_pct}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted">Tickets (90j)</div>
                  <div className="num text-2xl font-medium">{searchResult.nb_tickets_90j}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted">Ventes (90j)</div>
                  <div className="num text-2xl font-medium">{searchResult.nb_ventes_90j}</div>
                </div>
              </div>
              <p className="text-xs text-muted mt-3 max-w-md">
                Taux exprimé en % des ventes — un produit très vendu peut avoir plus de tickets en
                valeur absolue sans être problématique en proportion.
              </p>
              <button
                onClick={() => openDetail(searchResult.product_ref)}
                className="mt-4 px-4 py-2 text-xs uppercase tracking-widest font-medium bg-accent text-white hover:bg-accent/90"
              >
                Voir le détail SAV
              </button>
            </div>
          </Card>
        )}
        {search.trim() && !searchResult && !loading && (
          <div className="text-sm text-muted italic mt-3">Aucune référence trouvée pour « {search} ».</div>
        )}
      </div>

      <div>
        <SectionTitle kicker="Classement" title="Top 50 — taux de SAV" byline={`${top50.length} réf · min. ${MIN_VENTES} ventes`} />
        {loading ? <Loading /> : top50.length === 0 ? <Empty /> : (
          <Card className="p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-muted border-b border-ink/10">
                  <th className="text-left px-4 py-3">#</th>
                  <th className="text-left px-4 py-3">Référence</th>
                  <th className="text-left px-4 py-3">Produit</th>
                  <th className="text-left px-4 py-3">Motif dominant</th>
                  <th className="text-right px-4 py-3">Tickets (90j)</th>
                  <th className="text-right px-4 py-3">Ventes (90j)</th>
                  <th className="text-right px-4 py-3">Taux SAV</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {top50.map((s, i) => (
                  <tr key={s.product_ref} className="border-b border-ink/5 hover:bg-warm/40">
                    <td className="px-4 py-2.5 text-muted font-mono">{i + 1}</td>
                    <td className="px-4 py-2.5 font-mono font-medium">{s.product_ref}</td>
                    <td className="px-4 py-2.5 text-xs text-muted max-w-[240px] truncate" title={s.product_name || ''}>
                      {s.product_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted">{s.top_category ? categoryLabel(s.top_category) : '—'}</td>
                    <td className="px-4 py-2.5 text-right num">{s.nb_tickets_90j}</td>
                    <td className="px-4 py-2.5 text-right num text-muted">{s.nb_ventes_90j}</td>
                    <td className="px-4 py-2.5 text-right num font-medium text-accent">
                      {s.taux_sav_pct != null ? `${s.taux_sav_pct}%` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => openDetail(s.product_ref)} className="text-xs text-accent underline underline-offset-2">
                        Détail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {selectedRef && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 flex items-stretch justify-end"
          onClick={() => setSelectedRef(null)}
        >
          <div
            className="bg-paper w-full max-w-2xl h-full overflow-y-auto p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-6">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-accent mb-1">Détail SAV</div>
                <h3 className="font-display text-3xl font-medium">{selectedRef}</h3>
              </div>
              <button onClick={() => setSelectedRef(null)} className="text-2xl text-muted hover:text-ink">×</button>
            </div>

            {detailLoading ? <Loading /> : (
              <>
                {breakdown.length > 0 && (
                  <Card className="mb-6">
                    <ProductWheel refId={selectedRef} breakdown={breakdown} />
                  </Card>
                )}
                <div className="text-[10px] uppercase tracking-widest text-muted mb-3">
                  Ce que disent les clients — {detailTickets?.length || 0} ticket(s)
                </div>
                <div className="space-y-2">
                  {(detailTickets || []).map((t) => (
                    <div key={t.id} className="border border-ink/10 p-3 text-sm">
                      <div className="flex justify-between gap-3 items-start">
                        <div className="font-medium">{t.subject || '(sans sujet)'}</div>
                        <span className="text-[10px] uppercase tracking-wider text-muted whitespace-nowrap">
                          {channelLabel(t.channel_key)}
                        </span>
                      </div>
                      <div className="text-xs text-muted mt-1">
                        {categoryLabel(t.category)} · {t.created_at ? new Date(t.created_at).toLocaleDateString('fr-FR') : '—'}
                        {t.edesk_order_reference ? ` · Cmd ${t.edesk_order_reference}` : ''}
                      </div>
                      {t.first_message_body && (
                        <blockquote className="mt-2 text-xs text-ink/80 italic border-l-2 border-accent/30 pl-3 whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {t.first_message_body}
                        </blockquote>
                      )}
                    </div>
                  ))}
                  {detailTickets && detailTickets.length === 0 && <Empty message="Aucun ticket pour cette référence." />}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
