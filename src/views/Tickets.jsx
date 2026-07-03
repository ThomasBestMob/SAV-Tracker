import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { supabase } from '../supabaseClient';
import { Card, SectionTitle, Stat, Loading, Empty, PriorityBadge, CategoryPill, categoryLabel } from '../components/Atoms';

function periodStart(period) {
  const d = new Date();
  d.setDate(d.getDate() - Number(period));
  return d.toISOString();
}

function isoWeek(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
}

async function downloadInvoice(orderRef) {
  try {
    const r = await fetch(`/api/invoice?order_ref=${encodeURIComponent(orderRef)}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || "Téléchargement facture pas encore configuré (nécessite la ressource PrestaShop order_invoices).");
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facture_${orderRef}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Erreur téléchargement facture : ' + e.message);
  }
}

export default function Tickets({ selectedChannel, period }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');

  useEffect(() => {
    setLoading(true);
    let query = supabase
      .from('sav_tickets')
      .select('id,subject,category,status,priority_score,priority_level,priority_reasons,channel_id,channel_name,order_refs,order_reference,order_value,created_at,last_message_at,message_count')
      .neq('status', 'closed')
      .gte('created_at', periodStart(period))
      .order('priority_score', { ascending: false })
      .limit(500);
    if (selectedChannel !== 'all') query = query.eq('channel_id', selectedChannel);

    query.then(({ data, error }) => {
      if (!error && data) setTickets(data);
      setLoading(false);
    });
  }, [selectedChannel, period]);

  const [chartData, setChartData] = useState([]);
  useEffect(() => {
    async function loadChart() {
      const since = periodStart(Math.max(Number(period), 90)).slice(0, 10);
      const [{ data: ticketRows }, { data: salesRows }] = await Promise.all([
        supabase.from('sav_tickets').select('created_at').gte('created_at', since),
        supabase.from('ps_sales_daily').select('sale_date,quantity').gte('sale_date', since).limit(50000),
      ]);
      const ticketsByWeek = {};
      (ticketRows || []).forEach((t) => {
        const w = isoWeek(t.created_at);
        ticketsByWeek[w] = (ticketsByWeek[w] || 0) + 1;
      });
      const salesByWeekMap = {};
      (salesRows || []).forEach((s) => {
        const w = isoWeek(s.sale_date);
        salesByWeekMap[w] = (salesByWeekMap[w] || 0) + (s.quantity || 0);
      });
      const weeks = [...new Set([...Object.keys(ticketsByWeek), ...Object.keys(salesByWeekMap)])].sort();
      setChartData(weeks.map((w) => ({ week: w, tickets: ticketsByWeek[w] || 0, ventes: salesByWeekMap[w] || 0 })));
    }
    loadChart().catch(() => {});
  }, [period]);

  const categoryBreakdown = useMemo(() => {
    const byCat = {};
    tickets.forEach((t) => { byCat[t.category || 'autre'] = (byCat[t.category || 'autre'] || 0) + 1; });
    return Object.entries(byCat).map(([category, count]) => ({ category, count, label: categoryLabel(category) })).sort((a, b) => b.count - a.count);
  }, [tickets]);

  const filtered = useMemo(() => {
    let rows = tickets;
    if (categoryFilter !== 'all') rows = rows.filter((t) => t.category === categoryFilter);
    const sorted = [...rows].sort((a, b) => {
      if (sortBy === 'priority') return (b.priority_score || 0) - (a.priority_score || 0);
      if (sortBy === 'recent') return (b.created_at || '').localeCompare(a.created_at || '');
      if (sortBy === 'old') return (a.created_at || '').localeCompare(b.created_at || '');
      return 0;
    });
    return sorted;
  }, [tickets, categoryFilter, sortBy]);

  const critiques = tickets.filter((t) => t.priority_level === 'critique').length;
  const hautes = tickets.filter((t) => t.priority_level === 'haute').length;

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <Stat label="Tickets ouverts" value={tickets.length} />
        <Stat label="Priorité critique" value={critiques} urgent={critiques > 0} />
        <Stat label="Priorité haute" value={hautes} accent />
        <Stat label="Catégorie dominante" value={categoryBreakdown[0]?.label || '—'} sub={categoryBreakdown[0] ? `${categoryBreakdown[0].count} tickets` : ''} />
      </div>

      <div>
        <SectionTitle kicker="Synthèse" title="Problématiques principales" byline={`${tickets.length} tickets ouverts`} />
        {loading ? <Loading /> : categoryBreakdown.length === 0 ? <Empty /> : (
          <Card>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={categoryBreakdown} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#0a0a0a10" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="label" type="category" width={140} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#1d5fae" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>

      <div>
        <SectionTitle kicker="Corrélation" title="Volume de tickets vs ventes" byline="par semaine ISO" />
        <Card>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0a0a0a10" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="tickets" name="Tickets SAV" stroke="#c8401c" strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="ventes" name="Ventes (unités)" stroke="#1d5fae" strokeWidth={2} dot={false} strokeDasharray="4 3" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div>
        <SectionTitle kicker="Traitement" title="File de tickets priorisée" byline={`${filtered.length} affichés`} />
        <div className="flex gap-3 mb-4 text-xs">
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="bg-transparent border border-ink/20 px-3 py-1.5 font-mono uppercase tracking-wider">
            <option value="all">Toutes catégories</option>
            {categoryBreakdown.map((c) => <option key={c.category} value={c.category}>{c.label}</option>)}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="bg-transparent border border-ink/20 px-3 py-1.5 font-mono uppercase tracking-wider">
            <option value="priority">Tri : priorité</option>
            <option value="recent">Tri : plus récent</option>
            <option value="old">Tri : plus ancien</option>
          </select>
        </div>
        {loading ? <Loading /> : filtered.length === 0 ? <Empty /> : (
          <div className="space-y-2">
            {filtered.slice(0, 100).map((t) => (
              <Card key={t.id} className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <PriorityBadge level={t.priority_level} />
                    <CategoryPill category={t.category} />
                    {t.channel_name && <span className="text-[10px] uppercase tracking-wider text-muted">{t.channel_name}</span>}
                  </div>
                  <div className="font-medium text-sm truncate">{t.subject || '(sans sujet)'}</div>
                  <div className="text-xs text-muted mt-1">
                    #{t.id} · {t.created_at ? new Date(t.created_at).toLocaleDateString('fr-FR') : '—'}
                    {t.order_refs?.length ? ` · ${t.order_refs.join(', ')}` : ''}
                    {t.order_value ? ` · ${Number(t.order_value).toFixed(0)} €` : ''}
                  </div>
                  {t.priority_reasons?.length > 0 && (
                    <div className="text-[11px] text-muted mt-1.5 italic">{t.priority_reasons[0]}</div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <span className="num text-lg font-medium text-accent">{t.priority_score}</span>
                  {t.category === 'facture' && t.order_reference && (
                    <button
                      onClick={() => downloadInvoice(t.order_reference)}
                      className="text-[10px] uppercase tracking-wider px-2 py-1 border border-accent text-accent hover:bg-accent hover:text-white transition-colors whitespace-nowrap"
                    >
                      Facture PDF
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
