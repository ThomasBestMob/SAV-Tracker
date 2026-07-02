import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Card, SectionTitle, Loading, Empty, categoryLabel } from '../components/Atoms';

function periodStart(period) {
  const d = new Date();
  d.setDate(d.getDate() - Number(period));
  return d.toISOString();
}

function currentMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export default function Notation({ period }) {
  const [tickets, setTickets] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from('sav_tickets').select('channel_id,channel_name,category,created_at').gte('created_at', periodStart(period)),
      supabase.from('sav_channel_ratings').select('*').order('period', { ascending: false }),
    ]).then(([{ data: t }, { data: r }]) => {
      setTickets(t || []);
      setRatings(r || []);
      setLoading(false);
    });
  }, [period]);

  const byChannel = useMemo(() => {
    const map = {};
    tickets.forEach((t) => {
      const key = t.channel_id ?? 'unknown';
      if (!map[key]) map[key] = { channel_id: t.channel_id, channel_name: t.channel_name || 'Inconnu', total: 0, byCategory: {} };
      map[key].total += 1;
      map[key].byCategory[t.category || 'autre'] = (map[key].byCategory[t.category || 'autre'] || 0) + 1;
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [tickets]);

  function latestRating(channelId) {
    return ratings.find((r) => r.channel_id === channelId);
  }

  async function saveRating(channelId, value) {
    const period_ = currentMonthStart();
    const rating = value === '' ? null : Number(value);
    const { error } = await supabase
      .from('sav_channel_ratings')
      .upsert({ channel_id: channelId, period: period_, rating }, { onConflict: 'channel_id,period' });
    if (error) { alert('Erreur : ' + error.message); return; }
    setRatings((prev) => {
      const others = prev.filter((r) => !(r.channel_id === channelId && r.period === period_));
      return [{ channel_id: channelId, period: period_, rating }, ...others];
    });
  }

  return (
    <div className="space-y-10">
      <div>
        <SectionTitle kicker="Suivi" title="Note et volume SAV par canal" byline={`${period} derniers jours`} />
        {loading ? <Loading /> : byChannel.length === 0 ? <Empty /> : (
          <Card className="p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-muted border-b border-ink/10">
                  <th className="text-left px-4 py-3">Canal</th>
                  <th className="text-right px-4 py-3">Tickets SAV</th>
                  <th className="text-right px-4 py-3">Note (saisie manuelle)</th>
                  <th className="text-left px-4 py-3">Problématique dominante</th>
                </tr>
              </thead>
              <tbody>
                {byChannel.map((c) => {
                  const topCat = Object.entries(c.byCategory).sort((a, b) => b[1] - a[1])[0];
                  const rating = latestRating(c.channel_id);
                  return (
                    <tr key={c.channel_id ?? 'unknown'} className="border-b border-ink/5">
                      <td className="px-4 py-2.5 font-medium">{c.channel_name}</td>
                      <td className="px-4 py-2.5 text-right num">{c.total}</td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          min="0"
                          max="5"
                          step="0.01"
                          defaultValue={rating?.rating ?? ''}
                          placeholder="—"
                          onBlur={(e) => saveRating(c.channel_id, e.target.value)}
                          className="w-20 bg-transparent border border-ink/20 px-2 py-1 text-right font-mono focus:outline-none focus:border-accent"
                        />
                        <span className="text-muted text-xs ml-1">/5</span>
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
        <p className="text-xs text-muted mt-3 max-w-2xl">
          La note vendeur provient de chaque marketplace individuellement (pas exposée par l'API eDesk
          dans le périmètre actuel du jeton) — saisie manuelle mensuelle en attendant une éventuelle
          intégration directe par marketplace.
        </p>
      </div>

      <div>
        <SectionTitle kicker="Détail" title="Récap des problématiques par canal" />
        {loading ? <Loading /> : byChannel.length === 0 ? <Empty /> : (
          <div className="grid md:grid-cols-2 gap-4">
            {byChannel.map((c) => (
              <Card key={c.channel_id ?? 'unknown'}>
                <div className="font-medium text-sm mb-3">{c.channel_name}</div>
                <div className="space-y-1.5">
                  {Object.entries(c.byCategory)
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, count]) => (
                      <div key={cat} className="flex justify-between items-center text-xs">
                        <span className="text-muted">{categoryLabel(cat)}</span>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-1.5 bg-ink/10 rounded-full overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${Math.min(100, (count / c.total) * 100)}%` }} />
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
