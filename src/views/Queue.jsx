import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Card, SectionTitle, Stat, Loading, Empty, CategoryPill } from '../components/Atoms';
import { triage, bySlaUrgency, ACTIONS, channelLabel, draftReply, trackingUrl } from '../lib/triage';

const SLA_STYLES = {
  breached: 'bg-urgent/10 text-urgent border-urgent/40',
  critical: 'bg-orange-100 text-orange-700 border-orange-300',
  soon: 'bg-amber-50 text-amber-700 border-amber-200',
  ok: 'bg-ink/5 text-muted border-ink/10',
  unknown: 'bg-ink/5 text-muted border-ink/10',
};

const ACTION_TONES = {
  urgent: 'text-urgent border-urgent/30',
  warn: 'text-amber-700 border-amber-300',
  accent: 'text-accent border-accent/30',
  neutral: 'text-muted border-ink/15',
};

function SlaBadge({ sla }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium border rounded-sm ${SLA_STYLES[sla.level]}`}>
      {sla.label}
    </span>
  );
}

function CopyButton({ text, label = 'Copier la réponse' }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        });
      }}
      className="text-[10px] uppercase tracking-wider px-2 py-1 border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
    >
      {done ? '✓ Copié' : label}
    </button>
  );
}

async function downloadInvoice(psOrderId, ref) {
  try {
    const r = await fetch(`/api/invoice?order_id=${encodeURIComponent(psOrderId)}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      alert(body.error || 'Récupération de la facture indisponible.');
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facture_${ref || psOrderId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Erreur téléchargement facture : ' + e.message);
  }
}

function TicketCard({ t }) {
  const [open, setOpen] = useState(false);
  const draft = draftReply(t);
  const track = trackingUrl(t);
  const tone = ACTION_TONES[t.actionMeta?.tone] || ACTION_TONES.neutral;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <SlaBadge sla={t.sla} />
            <span className={`inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium border rounded-sm ${tone}`}>
              {t.actionMeta?.label}
            </span>
            <CategoryPill category={t.category} />
            <span className="text-[10px] uppercase tracking-wider text-muted">{channelLabel(t.channel_key)}</span>
          </div>

          <div className="font-medium text-sm">{t.subject || '(sans sujet)'}</div>

          <div className="text-xs text-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>#{t.id}</span>
            {t.edesk_order_reference && <span>Cmd {t.edesk_order_reference}</span>}
            {t.order_value ? <span>{Math.round(t.order_value)} €</span> : null}
            {t.product_refs?.length ? <span className="font-mono">{t.product_refs.join(' · ')}</span> : null}
            {t.message_count ? <span>{t.message_count} msg</span> : null}
          </div>

          {t.reasons.length > 0 && (
            <div className="text-[11px] text-muted mt-1.5">{t.reasons.join(' — ')}</div>
          )}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {t.action === 'envoyer_facture' && (
            <button
              onClick={() => downloadInvoice(t.ps_order_id, t.edesk_order_reference)}
              className="text-[10px] uppercase tracking-wider px-2 py-1 border border-accent text-accent hover:bg-accent hover:text-white transition-colors whitespace-nowrap"
            >
              Facture PDF
            </button>
          )}
          {track && (
            <a
              href={track}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] uppercase tracking-wider px-2 py-1 border border-ink/20 text-muted hover:border-accent hover:text-accent transition-colors whitespace-nowrap"
            >
              Suivi colis
            </a>
          )}
          <button onClick={() => setOpen((v) => !v)} className="text-[10px] uppercase tracking-wider text-accent hover:underline whitespace-nowrap">
            {open ? 'Réduire' : 'Ouvrir'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-ink/10 grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1.5">Demande du client</div>
            <div className="text-xs whitespace-pre-wrap bg-ink/[0.03] border border-ink/10 p-3 max-h-72 overflow-y-auto">
              {t.first_message_body || <span className="italic text-muted">Message non synchronisé.</span>}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1.5 flex items-center justify-between">
              <span>Réponse suggérée</span>
              <CopyButton text={draft} />
            </div>
            {draft ? (
              <div className="text-xs whitespace-pre-wrap bg-accent/[0.04] border border-accent/20 p-3">{draft}</div>
            ) : (
              <div className="text-xs italic text-muted p-3 border border-dashed border-ink/15">
                Pas de réponse type pour cette action — à traiter manuellement dans eDesk.
              </div>
            )}
            {t.product_names?.length > 0 && (
              <div className="mt-3 text-[11px] text-muted">
                <span className="uppercase tracking-widest">Produits</span> — {t.product_names.join(', ')}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function Queue({ selectedChannel, period }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('all');

  useEffect(() => {
    setLoading(true);
    const since = new Date(Date.now() - Number(period) * 86_400_000).toISOString();
    let q = supabase
      .from('sav_ticket_enriched')
      .select('*')
      .neq('status', 'closed')
      .gte('created_at', since)
      .limit(1000);
    if (selectedChannel !== 'all') q = q.eq('channel_key', selectedChannel);

    q.then(({ data, error }) => {
      if (!error && data) setRows(data);
      setLoading(false);
    });
  }, [selectedChannel, period]);

  const triaged = useMemo(() => rows.map((r) => triage(r)).sort(bySlaUrgency), [rows]);

  const counts = useMemo(() => {
    const c = { breached: 0, critical: 0, automatable: 0 };
    triaged.forEach((t) => {
      if (t.sla.level === 'breached') c.breached += 1;
      if (t.sla.level === 'critical') c.critical += 1;
      if (t.actionMeta?.automatable) c.automatable += 1;
    });
    return c;
  }, [triaged]);

  const byAction = useMemo(() => {
    const map = {};
    triaged.forEach((t) => { map[t.action] = (map[t.action] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [triaged]);

  const filtered = useMemo(
    () => (actionFilter === 'all' ? triaged : triaged.filter((t) => t.action === actionFilter)),
    [triaged, actionFilter]
  );

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <Stat label="Hors délai" value={counts.breached} urgent={counts.breached > 0} sub="SLA canal dépassé" />
        <Stat label="Sous 4 h" value={counts.critical} accent sub="à traiter maintenant" />
        <Stat label="Réponse outillée" value={counts.automatable} sub="matériel déjà prêt" />
        <Stat label="File ouverte" value={triaged.length} sub={`${period} derniers jours`} />
      </div>

      <div>
        <SectionTitle
          kicker="Ma journée"
          title="File de traitement"
          byline="triée par échéance de réponse"
        />

        <div className="flex gap-2 mb-5 flex-wrap text-xs">
          <button
            onClick={() => setActionFilter('all')}
            className={`px-3 py-1.5 border uppercase tracking-wider ${actionFilter === 'all' ? 'border-accent text-accent' : 'border-ink/20 text-muted'}`}
          >
            Tout ({triaged.length})
          </button>
          {byAction.map(([action, n]) => (
            <button
              key={action}
              onClick={() => setActionFilter(action)}
              className={`px-3 py-1.5 border uppercase tracking-wider ${actionFilter === action ? 'border-accent text-accent' : 'border-ink/20 text-muted'}`}
            >
              {ACTIONS[action]?.label} ({n})
            </button>
          ))}
        </div>

        {loading ? <Loading /> : filtered.length === 0 ? <Empty message="Rien à traiter — file vide." /> : (
          <div className="space-y-2">
            {filtered.slice(0, 150).map((t) => <TicketCard key={t.id} t={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}
