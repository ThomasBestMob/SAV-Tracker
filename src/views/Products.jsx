import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Loading, Empty, categoryLabel } from '../components/Atoms';
import { channelLabel } from '../lib/triage';
import { productIssueLabel, productIssueHint } from '../lib/productIssues';

// Sans plancher de ventes, le classement par taux remonte des références à
// 1 vente / 1 ticket affichées à 100 %, qui masquent les vraies anomalies.
const MIN_VENTES = 10;

/**
 * Vue équipe offre. Elle répond à une question précise : sur quelles références
 * faut-il agir, et pourquoi.
 *
 * L'axe de lecture est la NATURE DU DÉFAUT (casse, affaissement, couleur…), pas
 * la catégorie de ticket (livraison, facture…) qui décrit une démarche SAV et
 * n'apprend rien sur le produit. Les verbatims sont affichés bruts : c'est ce
 * qui déclenche une décision, pas un pourcentage.
 */
export default function Products() {
  const [issueStats, setIssueStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [issue, setIssue] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  function load() {
    setLoading(true);
    setLoadError(null);
    supabase
      .from('sav_product_issue_stats')
      .select('*')
      .limit(5000)
      .then(({ data, error }) => {
        if (error) { setLoadError(error.message); }
        else if (data) setIssueStats(data);
        setLoading(false);
      });
  }

  useEffect(load, []);

  // Volume par nature de défaut, toutes références confondues — la première
  // lecture utile : où est le gros du problème sur l'ensemble du catalogue.
  const byIssue = useMemo(() => {
    const map = {};
    issueStats.forEach((r) => { map[r.issue] = (map[r.issue] || 0) + r.nb_tickets; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [issueStats]);

  // Agrégation par référence, restreinte au défaut sélectionné le cas échéant.
  const products = useMemo(() => {
    const rows = issue === 'all' ? issueStats : issueStats.filter((r) => r.issue === issue);
    const map = {};
    rows.forEach((r) => {
      if (!map[r.product_ref]) {
        map[r.product_ref] = {
          product_ref: r.product_ref,
          product_name: r.product_name,
          nb_ventes: r.nb_ventes_180j,
          nb_tickets: 0,
          issues: {},
          dernier: null,
        };
      }
      const p = map[r.product_ref];
      p.nb_tickets += r.nb_tickets;
      p.issues[r.issue] = (p.issues[r.issue] || 0) + r.nb_tickets;
      if (!p.dernier || r.dernier_ticket_at > p.dernier) p.dernier = r.dernier_ticket_at;
    });

    return Object.values(map)
      .map((p) => ({
        ...p,
        taux_pct: p.nb_ventes >= MIN_VENTES ? Math.round((p.nb_tickets / p.nb_ventes) * 1000) / 10 : null,
      }))
      .filter((p) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return p.product_ref.toLowerCase().includes(q) || String(p.product_name || '').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // À taux comparable, le volume tranche : une réf à 8 % sur 500 ventes
        // est un chantier plus lourd qu'une réf à 12 % sur 12 ventes.
        if (a.taux_pct == null && b.taux_pct == null) return b.nb_tickets - a.nb_tickets;
        if (a.taux_pct == null) return 1;
        if (b.taux_pct == null) return -1;
        return b.taux_pct - a.taux_pct || b.nb_tickets - a.nb_tickets;
      });
  }, [issueStats, issue, search]);

  async function openDetail(ref) {
    setSelected(ref);
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    const { data, error } = await supabase.rpc('get_product_verbatims', {
      p_ref: ref,
      p_issue: issue !== 'all' ? issue : null,
    });
    if (error) setDetailError(error.message);
    else setDetail(data || []);
    setDetailLoading(false);
  }

  const totalTickets = useMemo(() => products.reduce((s, p) => s + p.nb_tickets, 0), [products]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5 items-center">
        <button
          onClick={() => setIssue('all')}
          className={`px-2.5 py-1 text-[11px] border uppercase tracking-wider ${issue === 'all' ? 'border-accent text-accent' : 'border-ink/20 text-muted'}`}
        >
          Tous défauts
        </button>
        {byIssue.map(([key, n]) => (
          <button
            key={key}
            onClick={() => setIssue(key)}
            title={productIssueHint(key) || ''}
            className={`px-2.5 py-1 text-[11px] border uppercase tracking-wider ${issue === key ? 'border-accent text-accent' : 'border-ink/20 text-muted'}`}
          >
            {productIssueLabel(key)} <span className="num">{n}</span>
          </button>
        ))}
      </div>

      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="text-[11px] text-muted max-w-2xl">
          {issue === 'all' ? (
            <>Références générant des défauts produit — hors motifs purement logistiques ou administratifs. Taux calculé à partir de {MIN_VENTES} ventes minimum.</>
          ) : (
            <><strong className="text-ink">{productIssueLabel(issue)}</strong> — {productIssueHint(issue)}</>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {issueStats.length > 0 && (() => {
            const dates = issueStats.map(r => r.dernier_ticket_at).filter(Boolean).sort();
            const oldest = dates[0] ? new Date(dates[0]).toLocaleDateString('fr-FR') : null;
            const newest = dates[dates.length - 1] ? new Date(dates[dates.length - 1]).toLocaleDateString('fr-FR') : null;
            return oldest && newest ? (
              <span className="text-[10px] text-muted font-mono whitespace-nowrap">
                {oldest === newest ? `au ${newest}` : `${oldest} → ${newest}`}
              </span>
            ) : null;
          })()}
          <input
            type="text"
            placeholder="Réf ou nom produit"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent border border-ink/20 px-3 py-1.5 text-xs focus:outline-none focus:border-accent font-mono w-52"
          />
        </div>
      </div>

      {loading ? <Loading /> : loadError ? (
        <div className="border border-urgent/30 bg-urgent/5 px-4 py-3 text-xs text-urgent flex items-center justify-between gap-4">
          <span>Erreur de chargement : {loadError}</span>
          <button onClick={load} className="text-[11px] uppercase tracking-wider border border-urgent/40 px-2 py-0.5 hover:bg-urgent/10">Réessayer</button>
        </div>
      ) : products.length === 0 ? (
        <Empty message="Aucun défaut produit détecté — lance le workflow avec reclassify_only:true pour classifier les tickets existants." />
      ) : (
        <div className="border border-ink/8 overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted border-b border-ink/10 bg-warm/40">
                <th className="text-left px-3 py-2 w-8">#</th>
                <th className="text-left px-3 py-2">Référence</th>
                <th className="text-left px-3 py-2">Produit</th>
                <th className="text-left px-3 py-2">Défauts relevés</th>
                <th className="text-right px-3 py-2">Tickets</th>
                <th className="text-right px-3 py-2">Ventes</th>
                <th className="text-right px-3 py-2">Taux</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 100).map((p, i) => (
                <tr key={p.product_ref} className="border-b border-ink/5 hover:bg-warm/30">
                  <td className="px-3 py-2 text-muted font-mono text-xs">{i + 1}</td>
                  <td className="px-3 py-2 font-mono font-medium">{p.product_ref}</td>
                  <td className="px-3 py-2 text-xs text-muted max-w-[220px] truncate" title={p.product_name || ''}>
                    {p.product_name || '—'}
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    {Object.entries(p.issues)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 3)
                      .map(([k, n]) => `${productIssueLabel(k)} (${n})`)
                      .join(' · ')}
                  </td>
                  <td className="px-3 py-2 text-right num font-medium">{p.nb_tickets}</td>
                  <td className="px-3 py-2 text-right num text-muted">{p.nb_ventes || '—'}</td>
                  <td className={`px-3 py-2 text-right num font-medium ${p.taux_pct != null && p.taux_pct >= 5 ? 'text-urgent' : 'text-accent'}`}>
                    {p.taux_pct != null ? `${p.taux_pct}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => openDetail(p.product_ref)} className="text-[11px] text-accent underline underline-offset-2">
                      Verbatims
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[11px] text-muted border-t border-ink/8">
            {products.length} référence{products.length > 1 ? 's' : ''} · {totalTickets} ticket{totalTickets > 1 ? 's' : ''}
            {products.length > 100 ? ' · 100 premières affichées' : ''}
          </div>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-40 bg-ink/40 flex items-stretch justify-end" onClick={() => setSelected(null)}>
          <div className="bg-paper w-full max-w-2xl h-full overflow-y-auto p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-accent mb-0.5">
                  Verbatims {issue !== 'all' ? `— ${productIssueLabel(issue)}` : ''}
                </div>
                <h3 className="font-display text-2xl font-medium">{selected}</h3>
              </div>
              <button onClick={() => setSelected(null)} className="text-2xl text-muted hover:text-ink leading-none">×</button>
            </div>

            {detailLoading ? <Loading /> : detailError ? (
              <div className="text-xs text-urgent border border-urgent/30 bg-urgent/5 p-3">{detailError}</div>
            ) : (
              <div className="space-y-2">
                {(detail || []).map((t) => (
                  <div key={t.id} className="border border-ink/10 p-3">
                    <div className="flex justify-between gap-3 items-start">
                      <div className="text-sm font-medium">{t.subject || '(sans sujet)'}</div>
                      <span className="text-[10px] uppercase tracking-wider text-muted whitespace-nowrap">{channelLabel(t.channel_key)}</span>
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {categoryLabel(t.category)} · {t.created_at ? new Date(t.created_at).toLocaleDateString('fr-FR') : '—'}
                      {t.edesk_order_reference ? ` · ${t.edesk_order_reference}` : ''}
                      {t.product_issues?.length ? ` · ${t.product_issues.map(productIssueLabel).join(', ')}` : ''}
                    </div>
                    {t.first_message_body ? (
                      <blockquote className="mt-2 text-xs text-ink/80 italic border-l-2 border-accent/30 pl-3 whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {t.first_message_body}
                      </blockquote>
                    ) : (
                      <div className="mt-2 text-[11px] italic text-muted">Message non synchronisé.</div>
                    )}
                  </div>
                ))}
                {detail && detail.length === 0 && <Empty message="Aucun verbatim pour ce filtre." />}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
