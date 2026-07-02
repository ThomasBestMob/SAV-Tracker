#!/usr/bin/env node
/**
 * eDesk → Supabase — sync des tickets SAV et données associées.
 *
 * ⚠️ Le schéma exact des réponses JSON eDesk n'a pas pu être vérifié sans
 * jeton réel (la doc developers.edesk.com ne montre pas les schémas de
 * réponse en statique). Ce script :
 *   - essaie plusieurs noms de champs plausibles (snake_case, d'après les
 *     noms des paramètres de filtre documentés : created_at, last_updated_at,
 *     owner_user_id, contact_id, channel_id, sales_order_id...)
 *   - stocke systématiquement le payload brut en JSONB (colonne `raw`)
 * Après le premier run réel, comparer sav_tickets.raw à quelques lignes pour
 * ajuster extractField() si besoin — aucune perte de données dans l'intervalle.
 *
 * Variables d'environnement requises (copier .env.example → .env) :
 *   EDESK_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * DRY_RUN=true : n'écrit rien dans Supabase, affiche un échantillon.
 * FULL_SYNC=true : ignore le curseur incrémental, retélécharge tout.
 */

import { classifyTicket, computeTicketPriority } from '../src/lib/priority.js';

const EDESK_BASE = 'https://api.edesk.com/v1';
const EDESK_TOKEN = process.env.EDESK_API_TOKEN || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const FULL_SYNC = String(process.env.FULL_SYNC || 'false').toLowerCase() === 'true';

if (!EDESK_TOKEN) { console.error('❌ EDESK_API_TOKEN requis.'); process.exit(1); }
if (!SB_URL || !SB_KEY) { console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1); }

// ── HTTP helpers ─────────────────────────────────────────────────────

async function edeskGet(path, params = {}) {
  const url = new URL(`${EDESK_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  const r = await fetch(url, {
    headers: {
      // Format d'auth non confirmé (doc statique ne le montre pas) : on essaie
      // Bearer en priorité (convention la plus courante), avec repli X-API-KEY
      // si le premier essai échoue en 401 (voir edeskGetWithFallback).
      Authorization: `Bearer ${EDESK_TOKEN}`,
      Accept: 'application/json',
    },
  });
  return r;
}

let _authMode = 'bearer';
async function edeskGetSmart(path, params) {
  let r = await edeskGet(path, params);
  if (r.status === 401 && _authMode === 'bearer') {
    _authMode = 'x-api-key';
    const url = new URL(`${EDESK_BASE}${path}`);
    Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
    r = await fetch(url, { headers: { 'X-API-KEY': EDESK_TOKEN, Accept: 'application/json' } });
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`eDesk ${r.status} sur ${path} : ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function edeskListAll(resource, params = {}, pageSize = 100, maxPages = 500) {
  const items = [];
  let page = 1;
  for (; page <= maxPages; page++) {
    const data = await edeskGetSmart(`/${resource}`, { ...params, page, per_page: pageSize, limit: pageSize });
    const batch = pickArray(data);
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

// La clé du tableau de résultats varie possiblement selon la ressource
// (ex. { tickets: [...] } vs { data: [...] }) — on essaie les variantes usuelles.
function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['data', 'items', 'results', 'tickets', 'sales_orders', 'messages', 'contacts', 'channels', 'tags', 'tag_groups', 'templates', 'users', 'order_notes']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

// Essaie plusieurs noms de champs candidats (snake_case, camelCase) sur un objet brut.
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

// ── Supabase helpers ─────────────────────────────────────────────────

async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  if (DRY_RUN) { console.log(`  [dry-run] ${table} : ${rows.length} lignes (non écrites)`); return; }
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table} ${r.status}: ${await r.text()}`);
}

async function sbSelect(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase select ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getSyncCursor(resource) {
  if (FULL_SYNC) return null;
  const rows = await sbSelect('sav_sync_state', `resource=eq.${resource}&select=last_synced_at`).catch(() => []);
  return rows[0]?.last_synced_at || null;
}

async function setSyncCursor(resource, iso) {
  await sbUpsert('sav_sync_state', [{ resource, last_synced_at: iso }], 'resource');
}

// ── Extraction par ressource ─────────────────────────────────────────

function extractChannel(c) {
  return { id: pick(c, 'id'), name: pick(c, 'name', 'title') || `Canal ${pick(c, 'id')}`, raw: c, updated_at: new Date().toISOString() };
}
function extractContact(c) {
  return { id: pick(c, 'id'), name: pick(c, 'name', 'full_name'), email: pick(c, 'email'), raw: c, updated_at: new Date().toISOString() };
}
function extractUser(u) {
  return { id: pick(u, 'id'), name: pick(u, 'name', 'full_name'), email: pick(u, 'email'), raw: u, updated_at: new Date().toISOString() };
}
function extractTagGroup(g) {
  return { id: pick(g, 'id'), name: pick(g, 'name'), raw: g, updated_at: new Date().toISOString() };
}
function extractTag(t) {
  return { id: pick(t, 'id'), tag_group_id: pick(t, 'tag_group_id', 'group_id'), name: pick(t, 'name'), raw: t, updated_at: new Date().toISOString() };
}
function extractTemplate(t) {
  return { id: pick(t, 'id'), name: pick(t, 'name', 'title'), body: pick(t, 'body', 'content'), raw: t, updated_at: new Date().toISOString() };
}

// Réf produits (SKU) des lignes de commande — plusieurs formes possibles selon
// la version d'API (line_items / order_lines / products), champ SKU sous
// plusieurs noms candidats.
function extractOrderRefs(o) {
  const lines = pick(o, 'line_items', 'order_lines', 'products', 'items') || [];
  if (!Array.isArray(lines)) return [];
  const refs = lines.map((l) => pick(l, 'sku', 'seller_sku', 'product_ref', 'reference')).filter(Boolean);
  return [...new Set(refs.map(String))];
}

function extractSalesOrder(o) {
  return {
    id: pick(o, 'id'),
    channel_id: pick(o, 'channel_id'),
    order_reference: pick(o, 'seller_order_id', 'order_reference', 'reference'),
    order_date: pick(o, 'order_date', 'created_at'),
    total_value: Number(pick(o, 'total', 'total_value', 'grand_total')) || null,
    currency: pick(o, 'currency'),
    order_refs: extractOrderRefs(o),
    raw: o,
    updated_at: new Date().toISOString(),
  };
}

function extractOrderNote(n) {
  return {
    id: pick(n, 'id'),
    sales_order_id: pick(n, 'sales_order_id', 'order_id'),
    body: pick(n, 'body', 'note', 'content'),
    created_at: pick(n, 'created_at'),
    raw: n,
    updated_at: new Date().toISOString(),
  };
}

function extractMessage(m, ticketId) {
  return {
    id: pick(m, 'id'),
    ticket_id: ticketId,
    direction: pick(m, 'direction', 'type'),
    body: pick(m, 'body', 'content', 'text'),
    author_name: pick(m, 'author_name', 'from_name', 'sender_name'),
    created_at: pick(m, 'created_at'),
    raw: m,
  };
}

function extractTags(t) {
  const tags = pick(t, 'tags') || [];
  if (!Array.isArray(tags)) return [];
  return tags.map((tg) => (typeof tg === 'string' ? tg : pick(tg, 'name'))).filter(Boolean);
}

// ── Main ─────────────────────────────────────────────────────────────

async function syncReferenceData() {
  console.log('▶ Canaux, utilisateurs, tags, templates, contacts...');
  const [channels, users, tagGroups, tags, templates, contacts] = await Promise.all([
    edeskListAll('channels').catch((e) => { console.warn('  channels:', e.message); return []; }),
    edeskListAll('users').catch((e) => { console.warn('  users:', e.message); return []; }),
    edeskListAll('tag_groups').catch((e) => { console.warn('  tag_groups:', e.message); return []; }),
    edeskListAll('tags').catch((e) => { console.warn('  tags:', e.message); return []; }),
    edeskListAll('templates').catch((e) => { console.warn('  templates:', e.message); return []; }),
    edeskListAll('contacts').catch((e) => { console.warn('  contacts:', e.message); return []; }),
  ]);
  await sbUpsert('sav_channels', channels.map(extractChannel), 'id');
  await sbUpsert('sav_users', users.map(extractUser), 'id');
  await sbUpsert('sav_tag_groups', tagGroups.map(extractTagGroup), 'id');
  await sbUpsert('sav_tags', tags.map(extractTag), 'id');
  await sbUpsert('sav_templates', templates.map(extractTemplate), 'id');
  await sbUpsert('sav_contacts', contacts.map(extractContact), 'id');
  console.log(`  ${channels.length} canaux, ${users.length} users, ${tags.length} tags, ${templates.length} templates, ${contacts.length} contacts.`);
  return { channelsById: new Map(channels.map((c) => [String(pick(c, 'id')), extractChannel(c).name])) };
}

async function syncSalesOrders() {
  const cursor = await getSyncCursor('sales_orders');
  console.log(`▶ Sales orders (depuis ${cursor || 'toujours'})...`);
  const params = cursor ? { filter_created_at_gte: Math.floor(new Date(cursor).getTime() / 1000) } : {};
  const orders = await edeskListAll('sales_orders', params).catch((e) => { console.warn('  sales_orders:', e.message); return []; });
  const rows = orders.map(extractSalesOrder).filter((r) => r.id != null);
  await sbUpsert('sav_sales_orders', rows, 'id');
  console.log(`  ${rows.length} commandes.`);

  console.log('▶ Order notes...');
  const notes = await edeskListAll('order_notes', params).catch((e) => { console.warn('  order_notes:', e.message); return []; });
  const noteRows = notes.map(extractOrderNote).filter((r) => r.id != null);
  await sbUpsert('sav_order_notes', noteRows, 'id');
  console.log(`  ${noteRows.length} notes.`);

  const bySalesOrderId = new Map(rows.map((o) => [String(o.id), o]));
  await setSyncCursor('sales_orders', new Date().toISOString());
  return bySalesOrderId;
}

async function syncTicketsAndMessages(channelsById, salesOrdersById) {
  const cursor = await getSyncCursor('tickets');
  console.log(`▶ Tickets (depuis ${cursor || 'toujours'})...`);
  const params = cursor ? { filter_last_updated_at_gte: cursor.slice(0, 10) } : {};
  const tickets = await edeskListAll('tickets', params).catch((e) => { console.warn('  tickets:', e.message); return []; });
  console.log(`  ${tickets.length} tickets à traiter.`);

  const ticketRows = [];
  const allMessageRows = [];
  let sample = null;

  for (const raw of tickets) {
    const id = pick(raw, 'id');
    if (id == null) continue;
    const salesOrderId = pick(raw, 'sales_order_id');
    const so = salesOrderId != null ? salesOrdersById.get(String(salesOrderId)) : null;
    const channelId = pick(raw, 'channel_id');

    let messages = [];
    try {
      const msgData = await edeskListAll('messages', { filter_ticket_id_equals: id }, 100, 20);
      messages = msgData;
    } catch (e) {
      console.warn(`  messages ticket ${id}:`, e.message);
    }
    const messageRows = messages.map((m) => extractMessage(m, id)).filter((m) => m.id != null);
    allMessageRows.push(...messageRows);

    const lastMessageAt = messageRows.reduce((max, m) => (m.created_at && (!max || m.created_at > max) ? m.created_at : max), null);
    const firstOutbound = messageRows
      .filter((m) => String(m.direction || '').toLowerCase().includes('out'))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))[0];

    const ticketForClassification = {
      subject: pick(raw, 'subject', 'title'),
      type: pick(raw, 'type'),
      tags: extractTags(raw),
    };
    const category = classifyTicket(ticketForClassification);

    const ticketForPriority = {
      status: pick(raw, 'status'),
      category,
      subject: ticketForClassification.subject,
      created_at: pick(raw, 'created_at'),
      last_message_at: lastMessageAt || pick(raw, 'last_updated_at', 'updated_at'),
      message_count: messageRows.length,
      order_value: so?.total_value,
      channel_name: channelsById.get(String(channelId)) || null,
    };
    const { score, level, reasons } = computeTicketPriority(ticketForPriority);

    const row = {
      id,
      sales_order_id: salesOrderId,
      contact_id: pick(raw, 'contact_id'),
      channel_id: channelId,
      channel_name: ticketForPriority.channel_name,
      owner_user_id: pick(raw, 'owner_user_id'),
      status: pick(raw, 'status'),
      type: pick(raw, 'type'),
      subject: ticketForClassification.subject,
      category,
      priority_score: score,
      priority_level: level,
      priority_reasons: reasons,
      tags: ticketForClassification.tags,
      message_count: messageRows.length,
      order_value: so?.total_value ?? null,
      order_refs: so?.order_refs ?? [],
      created_at: pick(raw, 'created_at'),
      updated_at: pick(raw, 'last_updated_at', 'updated_at'),
      last_message_at: lastMessageAt,
      first_response_at: firstOutbound?.created_at ?? null,
      raw,
      synced_at: new Date().toISOString(),
    };
    ticketRows.push(row);
    if (!sample) sample = row;
  }

  await sbUpsert('sav_tickets', ticketRows, 'id');
  await sbUpsert('sav_messages', allMessageRows, 'id');
  await setSyncCursor('tickets', new Date().toISOString());

  console.log(`  ${ticketRows.length} tickets synchronisés, ${allMessageRows.length} messages.`);
  if (sample) {
    console.log('\n📋 Exemple de ticket classifié :');
    console.log(`  #${sample.id} — ${sample.subject || '(sans sujet)'} — catégorie=${sample.category} priorité=${sample.priority_level} (${sample.priority_score})`);
    (sample.priority_reasons || []).forEach((r) => console.log(`    · ${r}`));
  }
}

async function main() {
  const { channelsById } = await syncReferenceData();
  const salesOrdersById = await syncSalesOrders();
  await syncTicketsAndMessages(channelsById, salesOrdersById);
  console.log(DRY_RUN ? '\n🧪 DRY_RUN=true : rien écrit dans Supabase.' : '\n✓ Sync terminé.');
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
