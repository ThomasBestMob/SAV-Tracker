import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { Loading, Empty, categoryLabel } from '../components/Atoms';
import { triage, bySlaUrgency, ACTIONS, BUCKETS, channelLabel, draftReply, trackingUrl } from '../lib/triage';
import { productIssueLabel } from '../lib/productIssues';
import { stripHtml } from '../lib/stripHtml';

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

// Extrait les URLs d'images du body brut (HTML ou texte).
function extractImageUrls(html) {
  if (!html) return [];
  const seen = new Set();
  const out = [];
  // <img src="..."> et URLs directes .jpg/.png/...
  const re = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi;
  for (const m of (html.matchAll ? html.matchAll(re) : [])) {
    const u = m[0].replace(/[)>'"]+$/, '');
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

function PhotosButton({ html }) {
  const [open, setOpen] = useState(false);
  const urls = extractImageUrls(html);
  if (!urls.length) return null;
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[10px] uppercase tracking-wider text-accent border border-accent/30 px-2 py-0.5 hover:bg-accent/10"
      >
        {open ? 'Masquer' : `Photos (${urls.length})`}
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-2">
          {urls.map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noreferrer">
              <img src={u} alt={`photo ${i + 1}`} className="max-h-40 max-w-[180px] object-contain border border-ink/10 rounded-sm" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

async function downloadInvoice(psOrderId, ref) {
  try {
    // Lookup PS order_id depuis la référence commande eDesk.
    // Deux chemins : commande site (order_reference) et marketplace (lengow_marketplace_order_id).
    let orderId = psOrderId;
    if (!orderId && ref) {
      const { supabase: sb } = await import('../supabaseClient');
      const { data } = await sb
        .from('ps_sales_daily')
        .select('order_id')
        .or(`order_reference.eq.${ref},lengow_marketplace_order_id.eq.${ref}`)
        .limit(1)
        .maybeSingle();
      orderId = data?.order_id;
    }
    if (!orderId) {
      alert(`Commande PrestaShop introuvable pour la référence "${ref}".`);
      return;
    }
    const r = await fetch(`/api/invoice?order_id=${encodeURIComponent(orderId)}`);
    if (!r.ok) {
      const raw = await r.text().catch(() => '');
      let msg;
      try { msg = JSON.parse(raw).error; } catch { msg = `HTTP ${r.status} — ${raw.slice(0, 200) || '(vide)'}`; }
      alert(msg || `HTTP ${r.status} sans détail.`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facture_${ref || orderId}.pdf`;
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
        <span className={`${chip} ${SLA_STYLES[t.sla.level]} min-w-[120px] text-center shrink-0`}>{t.sla.label}</span>
        <span className={`${chip} ${ACTION_TONES[t.actionMeta?.tone] || ACTION_TONES.neutral} w-[152px] text-center shrink-0`}>
          {t.actionMeta?.label}
        </span>

        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{t.subject || '(sans sujet)'}</div>
          <div className="text-[11px] text-muted flex flex-wrap gap-x-2.5 mt-0.5 items-center">
            <span className={`${chip} border-ink/20 text-muted`}>
              {t.channel_key ? channelLabel(t.channel_key) : (t.detectedMarketplace || 'Inconnu')}
            </span>
            <span className="text-ink/50">·</span>
            <span>{t.created_at ? new Date(t.created_at).toLocaleDateString('fr-FR') : '—'}</span>
            <span className="text-ink/50">·</span>
            <span>{categoryLabel(t.category)}</span>
            {t.product_issues?.length > 0 && (
              <span className="text-accent">{t.product_issues.map(productIssueLabel).join(', ')}</span>
            )}
            {t.edesk_order_reference && <span className="font-mono">{t.edesk_order_reference}</span>}
            {t.order_value ? <span>{Math.round(t.order_value)} €</span> : null}
            {t.message_count > 3 && (
              <span className="italic text-amber-700">{t.message_count} échanges — fil long</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {t.edesk_order_reference && (
            <button
              onClick={(e) => { e.stopPropagation(); downloadInvoice(t.ps_order_id, t.edesk_order_reference); }}
              className={`${chip} border-ink/20 text-muted hover:border-accent hover:text-accent transition-colors`}
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
              {t.first_message_body ? stripHtml(t.first_message_body) : (
                <span className="italic text-muted">
                  Message non synchronisé — ce ticket date d'avant la récupération des messages. Un sync complet le remplira.
                </span>
              )}
            </div>
            <PhotosButton html={t.first_message_body} />
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

export default function Queue({ selectedChannel }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [bucket, setBucket] = useState('a_traiter');
  const [actionFilter, setActionFilter] = useState('all');

  function load() {
    setLoading(true);
    setLoadError(null);
    // Pas de filtre par date : on veut TOUS les tickets ouverts,
    // qu'ils aient 2 jours ou 60 jours. Un ticket ouvert de 45 jours
    // ne disparaît pas parce que la période est réglée sur 30 j.
    let q = supabase
      .from('sav_ticket_light')
      .select('*')
      .eq('is_open', true)
      .eq('is_customer_request', true)
      .order('created_at', { ascending: false })
      .limit(1500);
    if (selectedChannel !== 'all') q = q.eq('channel_key', selectedChannel);

    q.then(({ data, error }) => {
      if (error) setLoadError(error.message);
      else if (data) setRows(data);
      setLoading(false);
    });
  }

  useEffect(load, [selectedChannel]);

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

      {loading ? <Loading /> : loadError ? (
        <div className="border border-urgent/30 bg-urgent/5 px-4 py-3 text-xs text-urgent flex items-center justify-between gap-4">
          <span>Erreur de chargement : {loadError}</span>
          <button onClick={load} className="text-[11px] uppercase tracking-wider border border-urgent/40 px-2 py-0.5 hover:bg-urgent/10">Réessayer</button>
        </div>
      ) : filtered.length === 0 ? (
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
