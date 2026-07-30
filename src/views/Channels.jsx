import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Card, SectionTitle, Stat, Loading, Empty, categoryLabel } from '../components/Atoms';
import { triage, channelLabel, slaHours } from '../lib/triage';

/**
 * Pilotage par canal. Remplace l'ancien onglet "Notation" (saisie manuelle
 * d'une note vendeur, sans conséquence opérationnelle) par les deux seules
 * métriques qui se pilotent réellement :
 *   - le taux de contact (tickets / commandes) : le volume brut n'est pas
 *     comparable entre canaux, un canal qui vend plus génère plus de tickets
 *     sans être moins bon pour autant ;
 *   - le respect du SLA, qui conditionne la santé du compte marketplace.
 */
export default function Channels({ period }) {
  const [stats, setStats] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const since = new Date(Date.now() - Number(period) * 86_400_000).toISOString();
    Promise.all([
      supabase.from('sav_channel_stats').select('*'),
      supabase
        .from('sav_ticket_enriched')
        .select('id,channel_key,category,created_at,last_message_at,ps_order_id,edesk_order_reference,message_count,order_value,tracking_code,expected_delivery_to,awaiting_us,is_customer_request')
        .eq('is_open', true)
        .eq('is_customer_request', true)
        .gte('created_at', since)
        .limit(5000),
    ]).then(([{ data: s }, { data: t }]) => {
      setStats(s || []);
      setTickets(t || []);
      setLoading(false);
    });
  }, [period]);

  const rows = useMemo(() => {
    // Le respect du SLA ne se mesure que sur les tickets dont la main est chez
    // nous : compter un dépassement sur un ticket en attente de réponse client
    // nous imputerait un retard qui n'est pas le nôtre.
    const open = tickets.filter((t) => t.awaiting_us !== false).map((t) => triage(t));
    const byChannel = {};
    open.forEach((t) => {
      const k = t.channel_key || 'autre';
      if (!byChannel[k]) byChannel[k] = { channel_key: k, open: 0, breached: 0, linked: 0, withRef: 0, byCategory: {} };
      const c = byChannel[k];
      c.open += 1;
      if (t.sla.level === 'breached') c.breached += 1;
      if (t.edesk_order_reference) { c.withRef += 1; if (t.ps_order_id) c.linked += 1; }
      c.byCategory[t.category || 'autre'] = (c.byCategory[t.category || 'autre'] || 0) + 1;
    });

    const statByKey = Object.fromEntries(stats.map((s) => [s.channel_key, s]));
    return Object.values(byChannel)
      .map((c) => ({
        ...c,
        taux_contact_pct: statByKey[c.channel_key]?.taux_contact_pct ?? null,
        nb_commandes_30j: statByKey[c.channel_key]?.nb_commandes_30j ?? null,
        slaPct: c.open > 0 ? Math.round(((c.open - c.breached) / c.open) * 100) : null,
        linkPct: c.withRef > 0 ? Math.round((c.linked / c.withRef) * 100) : null,
      }))
      .sort((a, b) => b.open - a.open);
  }, [tickets, stats]);

  const totals = useMemo(() => {
    const open = rows.reduce((s, r) => s + r.open, 0);
    const breached = rows.reduce((s, r) => s + r.breached, 0);
    const linked = rows.reduce((s, r) => s + r.linked, 0);
    const withRef = rows.reduce((s, r) => s + r.withRef, 0);
    return {
      open,
      slaPct: open > 0 ? Math.round(((open - breached) / open) * 100) : null,
      linkPct: withRef > 0 ? Math.round((linked / withRef) * 100) : null,
      breached,
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <Stat label="Respect SLA" value={totals.slaPct != null ? `${totals.slaPct}%` : '—'} accent sub="demandes encore dans les délais" />
        <Stat label="Hors délai" value={totals.breached} urgent={totals.breached > 0} sub="à rattraper" />
        <Stat label="Commandes rattachées" value={totals.linkPct != null ? `${totals.linkPct}%` : '—'} sub="ticket → PrestaShop" />
        <Stat label="En attente de nous" value={totals.open} sub={`${period} derniers jours`} />
      </div>

      <div>
        <SectionTitle kicker="Pilotage" title="Performance par canal" byline={`${rows.length} canaux actifs`} />
        {loading ? <Loading /> : rows.length === 0 ? <Empty /> : (
          <Card className="p-0 overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-muted border-b border-ink/10">
                  <th className="text-left px-4 py-3">Canal</th>
                  <th className="text-right px-4 py-3">SLA</th>
                  <th className="text-right px-4 py-3">Respect SLA</th>
                  <th className="text-right px-4 py-3">Hors délai</th>
                  <th className="text-right px-4 py-3">Tickets ouverts</th>
                  <th className="text-right px-4 py-3">Taux de contact</th>
                  <th className="text-right px-4 py-3">Rattachement</th>
                  <th className="text-left px-4 py-3">Motif dominant</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const topCat = Object.entries(c.byCategory).sort((a, b) => b[1] - a[1])[0];
                  return (
                    <tr key={c.channel_key} className="border-b border-ink/5">
                      <td className="px-4 py-2.5 font-medium">{channelLabel(c.channel_key)}</td>
                      <td className="px-4 py-2.5 text-right num text-muted">{slaHours(c.channel_key)} h</td>
                      <td className={`px-4 py-2.5 text-right num font-medium ${c.slaPct != null && c.slaPct < 80 ? 'text-urgent' : 'text-accent'}`}>
                        {c.slaPct != null ? `${c.slaPct}%` : '—'}
                      </td>
                      <td className={`px-4 py-2.5 text-right num ${c.breached > 0 ? 'text-urgent' : 'text-muted'}`}>{c.breached}</td>
                      <td className="px-4 py-2.5 text-right num">{c.open}</td>
                      <td className="px-4 py-2.5 text-right num" title={c.nb_commandes_30j ? `${c.nb_commandes_30j} commandes sur 30 j` : ''}>
                        {c.taux_contact_pct != null ? `${c.taux_contact_pct}%` : '—'}
                      </td>
                      <td className={`px-4 py-2.5 text-right num ${c.linkPct != null && c.linkPct < 70 ? 'text-amber-700' : 'text-muted'}`}>
                        {c.linkPct != null ? `${c.linkPct}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {topCat ? `${categoryLabel(topCat[0])} (${topCat[1]})` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
        <p className="text-xs text-muted mt-3 max-w-3xl">
          <strong>Taux de contact</strong> = tickets / commandes du canal sur 30 jours — c'est lui qui compare
          honnêtement les canaux, pas le volume brut. <strong>Rattachement</strong> = part des tickets dont la
          commande a pu être retrouvée dans PrestaShop : en dessous de 70 %, le format de référence du canal
          est probablement mal reconnu et les réponses outillées (facture, suivi) ne s'activent pas.
        </p>
      </div>

      <div>
        <SectionTitle kicker="Détail" title="Répartition des motifs" byline="par canal" />
        {loading ? <Loading /> : rows.length === 0 ? <Empty /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {rows.map((c) => (
              <Card key={c.channel_key}>
                <div className="font-medium text-sm mb-3">{channelLabel(c.channel_key)}</div>
                <div className="space-y-1.5">
                  {Object.entries(c.byCategory)
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, count]) => (
                      <div key={cat} className="flex justify-between items-center text-xs">
                        <span className="text-muted">{categoryLabel(cat)}</span>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-1.5 bg-ink/10 rounded-full overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${Math.min(100, (count / c.open) * 100)}%` }} />
                          </div>
                          <span className="num w-6 text-right">{count}</span>
                        </div>
                      </div>
                    ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
