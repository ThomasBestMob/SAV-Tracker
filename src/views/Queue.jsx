import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Loading, Empty, categoryLabel } from '../components/Atoms';
import { triage, bySlaUrgency, ACTIONS, BUCKETS, channelLabel, draftReply, trackingUrl } from '../lib/triage';
import { productIssueLabel } from '../lib/productIssues';

const SLA_STYLES = {
  breached: 'bg-urgent/10 text-urgent border-urgent/40',
  critical: 'bg-orange-100 text-orange-700 border-orange-300',
  soon: 'bg-amber-50 text-amber-700 border-amber-200',
  ok: 'bg-ink/5 text-muted border-ink/10',
  waiting: 'bg-ink/5 text-muted border-ink/10',
  unknown: 'bg-ink/5 text-muted border-ink/10',
};

const ACTION_TONES = {
  urgent: 'text-urgent border-urgent/30',
  warn: 'text-amber-700 border-amber-300',
  accent: 'text-accent border-accent/30',
  neutral: 'text-muted border-ink/15',
};

const chip = 'inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-medium border rounded-sm whitespace-nowrap';

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); })}
      className="text-[10px] uppercase tracking-wider px-2 py-0.5 border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
    >
      {done ? '✓ Copié' : 'Copier'}
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

function Row({ t }) {
  const [open, setOpen] = useState(false);
  const draft = draftReply(t);
  const track = trackingUrl(t);

  return (
    <div className="border-b border-ink/8 hover:bg-warm/30">
      <div className="px-3 py-2 flex items-baseline gap-3 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <span className={`${chip} ${SLA_STYLES[t.sla.level]} w-[132px] text-center shrink-0`}>{t.sla.label}</span>
        <span className={`${chip} ${ACTION_TONES[t.actionMeta?.tone] || ACTION_TONES.neutral} w-[152px] text-center shrink-0`}>
          {t.actionMeta?.label}
        </span>

        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{t.subject || '(sans sujet)'}</div>
          <div className="text-[11px] text-muted flex flex-wrap gap-x-2.5 mt-0.5">
            <span>{channelLabel(t.channel_key)}</span>
            <span>{categoryLabel(t.category)}</span>
            {t.product_issues?.length > 0 && (
              <span className="text-accent">{t.product_issues.map(productIssueLabel).join(', ')}</span>
            )}
            {t.edesk_order_reference && <span className="font-mono">{t.edesk_order_reference}</span>}
            {t.order_value ? <span>{Math.round(t.order_value)} €</span> : null}
            {t.reasons.length > 0 && <span className="italic">{t.reasons[0]}</span>}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {t.action === 'envoyer_facture' && (
            <button
              onClick={(e) => { e.stopPropagation(); downloadInvoice(t.ps_order_id, t.edesk_order_reference); }}
              className={`${chip} border-accent text-accent hover:bg-accent hover:text-white transition-colors`}
            >
              Facture
            </button>
          )}
          {track && (
            <a
              href={track}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`${chip} border-ink/20 text-muted hover:border-accent hover:text-accent`}
            >
              Suivi
            </a>
          )}
          <span className="text-muted text-xs w-3 text-center">{open ? '−' : '+'}</span>
        </div>
      </div>

      {open && (
        <div className="px-3 pb-3 grid md:grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1">
              Demande du client {t.first_message_author ? `— ${t.first_message_author}` : ''}
            </div>
            <div className="text-xs whitespace-pre-wrap bg-ink/[0.03] border border-ink/10 p-2.5 max-h-64 overflow-y-auto">
              {t.first_message_body || (
                <span className="italic text-muted">
                  Message non synchronisé — ce ticket date d'avant la récupération des messages. Un sync complet le remplira.
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1 flex items-center justify-between gap-2">
              <span>Réponse suggérée</span>
              <CopyButton text={draft} />
            </div>
            {draft ? (
              <div className="text-xs whitespace-pre-wrap bg-accent/[0.04] border border-accent/20 p-2.5">{draft}</div>
            ) : (
              <div className="text-xs italic text-muted p-2.5 border border-dashed border-ink/15">
                Pas de réponse type pour cette action — à traiter dans eDesk.
              </div>
            )}
            {t.product_names?.length > 0 && (
              <div className="mt-2 text-[11px] text-muted">{t.product_names.filter(Boolean).join(', ')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }) {
  const color = tone === 'urgent' ? 'text-urgent' : tone === 'accent' ? 'text-accent' : 'text-ink';
  return (
    <div className="px-4 py-2 border-l-2 border-ink/10 first:border-l-0 first:pl-0">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`num text-2xl font-medium leading-tight ${color}`}>{value}</div>
    </div>
  );
}

export default function Queue({ selectedChannel, period }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState('a_traiter');
  const [actionFilter, setActionFilter] = useState('all');

  useEffect(() => {
    setLoading(true);
    const since = new Date(Date.now() - Number(period) * 86_400_000).toISOString();
    let q = supabase
      .from('sav_ticket_enriched')
      .select('*')
      .eq('is_open', true)
      .gte('created_at', since)
      .limit(2000);
    if (selectedChannel !== 'all') q = q.eq('channel_key', selectedChannel);

    q.then(({ data, error }) => {
      if (!error && data) setRows(data);
      setLoading(false);
    });
  }, [selectedChannel, period]);

  const triaged = useMemo(() => rows.map((r) => triage(r)).sort(bySlaUrgency), [rows]);

  const buckets = useMemo(() => {
    const c = { a_traiter: 0, en_attente_client: 0, notification: 0 };
    triaged.forEach((t) => { c[t.bucket] += 1; });
    return c;
  }, [triaged]);

  const inBucket = useMemo(() => triaged.filter((t) => t.bucket === bucket), [triaged, bucket]);

  const kpis = useMemo(() => {
    const breached = inBucket.filter((t) => t.sla.level === 'breached').length;
    const critical = inBucket.filter((t) => t.sla.level === 'critical').length;
    const outillees = inBucket.filter((t) => t.actionMeta?.automatable).length;
    return { breached, critical, outillees };
  }, [inBucket]);

  const byAction = useMemo(() => {
    const map = {};
    inBucket.forEach((t) => { map[t.action] = (map[t.action] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [inBucket]);

  const filtered = useMemo(
    () => (actionFilter === 'all' ? inBucket : inBucket.filter((t) => t.action === actionFilter)),
    [inBucket, actionFilter]
  );

  return (
    <div className="space-y-4">
      {/* Onglets d'état : c'est le premier tri que fait l'agent — de quoi suis-je
          responsable maintenant — avant tout autre filtre. */}
      <div className="flex items-center gap-1 border-b border-ink/10">
        {Object.entries(BUCKETS).map(([key, def]) => (
          <button
            key={key}
            onClick={() => { setBucket(key); setActionFilter('all'); }}
            title={def.hint}
            className={`px-4 py-2 text-xs uppercase tracking-widest font-medium border-b-2 -mb-px transition-colors ${
              bucket === key ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {def.label} <span className="num ml-1">{buckets[key]}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex">
          <Kpi label="Hors délai" value={kpis.breached} tone={kpis.breached > 0 ? 'urgent' : undefined} />
          <Kpi label="Sous 4 h" value={kpis.critical} tone="accent" />
          <Kpi label="Réponse outillée" value={kpis.outillees} />
          <Kpi label="Total" value={inBucket.length} />
        </div>
        <p className="text-[11px] text-muted max-w-sm">{BUCKETS[bucket].hint} — trié par échéance de réponse.</p>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => setActionFilter('all')}
          className={`px-2.5 py-1 text-[11px] border uppercase tracking-wider ${actionFilter === 'all' ? 'border-accent text-accent' : 'border-ink/20 text-muted'}`}
        >
          Tout
        </button>
        {byAction.map(([action, n]) => (
          <button
            key={action}
            onClick={() => setActionFilter(action)}
            className={`px-2.5 py-1 text-[11px] border uppercase tracking-wider ${actionFilter === action ? 'border-accent text-accent' : 'border-ink/20 text-muted'}`}
          >
            {ACTIONS[action]?.label} <span className="num">{n}</span>
          </button>
        ))}
      </div>

      {loading ? <Loading /> : filtered.length === 0 ? (
        <Empty message={bucket === 'a_traiter' ? 'Rien à traiter — file vide.' : 'Aucun ticket dans cet état.'} />
      ) : (
        <div className="border-t border-ink/8">
          {filtered.slice(0, 200).map((t) => <Row key={t.id} t={t} />)}
          {filtered.length > 200 && (
            <div className="text-[11px] text-muted italic py-3 px-3">
              {filtered.length - 200} tickets supplémentaires non affichés — affine les filtres.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
