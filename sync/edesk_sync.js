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

// Bornes glissantes pour éviter de recharger tout l'historique à chaque run (coût API +
// risque de timeout/quota) : les tickets n'ont besoin que d'une fenêtre récente pour la
// priorisation, la vue produit ne regarde que 90 jours. Les commandes ont une fenêtre plus
// large car un ticket récent peut référencer une commande plus ancienne (délais SAV).
const TICKET_LOOKBACK_DAYS = parseInt(process.env.TICKET_LOOKBACK_DAYS || '14', 10);
const SALES_ORDER_LOOKBACK_DAYS = parseInt(process.env.SALES_ORDER_LOOKBACK_DAYS || '90', 10);

if (!EDESK_TOKEN) { console.error('❌ EDESK_API_TOKEN requis.'); process.exit(1); }
if (!SB_URL || !SB_KEY) { console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1); }

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// Plus récent entre le curseur incrémental et la fenêtre glissante — ne jamais remonter
// plus loin que la fenêtre, même sur le tout premier run (FULL_SYNC ou pas de curseur).
function effectiveSince(cursor, lookbackDays) {
  const floor = daysAgoIso(lookbackDays);
  if (!cursor) return floor;
  return cursor > floor ? cursor : floor;
}

// ── HTTP helpers ─────────────────────────────────────────────────────

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

// Retry avec backoff sur 429 ("Out of quota" observé en prod) — respecte
// Retry-After si présent, sinon backoff exponentiel. Ne masque pas une vraie
// panne : abandonne après MAX_RETRIES et laisse l'appelant gérer (déjà en
// try/catch partout, un ticket qui échoue n'interrompt pas les autres).
const MAX_429_RETRIES = 5;

async function edeskGetSmart(path, params) {
  let attempt = 0;
  for (;;) {
    let r = await edeskGet(path, params);
    if (r.status === 401 && _authMode === 'bearer') {
      _authMode = 'x-api-key';
      const url = new URL(`${EDESK_BASE}${path}`);
      Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
      r = await fetch(url, { headers: { 'X-API-KEY': EDESK_TOKEN, Accept: 'application/json' } });
    }
    if (r.status === 429 && attempt < MAX_429_RETRIES) {
      attempt += 1;
      const retryAfterHeader = parseInt(r.headers.get('retry-after') || '', 10);
      const waitMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : Math.min(30000, 1000 * 2 ** attempt);
      console.warn(`  429 sur ${path} — attente ${Math.round(waitMs / 1000)}s puis retry (${attempt}/${MAX_429_RETRIES})`);
      await sleep(waitMs);
      continue;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`eDesk ${r.status} sur ${path} : ${t.slice(0, 300)}`);
    }
    return r.json();
  }
}

// Pagination confirmée sur developers.edesk.com/reference/pagination :
// paramètres `page` + `itemsPerPage` (camelCase), réponse avec un objet
// `paginator.totalItemsCount`. Les anciens noms (per_page/limit) étaient
// ignorés par le serveur, qui retombait sur sa taille de page par défaut (20)
// à chaque appel — d'où le blocage après la 1ère page observé en prod.
async function edeskListAll(resource, params = {}, itemsPerPage = 100, maxPages = 1000) {
  const items = [];
  let page = 1;
  for (; page <= maxPages; page++) {
    const data = await edeskGetSmart(`/${resource}`, { ...params, page, itemsPerPage });
    const batch = pickArray(data);
    items.push(...batch);
    const total = data && typeof data === 'object' ? data.paginator?.totalItemsCount : null;
    if (!batch.length) break;
    if (total != null && items.length >= total) break;
    if (total == null && batch.length < itemsPerPage) break; // filet de sécurité si pas de paginator
  }
  return items;
}

// La clé du tableau de résultats varie possiblement selon la ressource
// (ex. { tickets: [...] } vs { data: [...] }) — on essaie les variantes usuelles.
function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['data', 'items', 'results', 'tickets', 'sales_orders', 'sales-orders', 'messages', 'contacts', 'channels', 'tags', 'tag_groups', 'tag-groups', 'templates', 'users', 'order_notes', 'order-notes']) {
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
  // Postgres refuse qu'un même upsert touche deux fois la même ligne
  // (ON CONFLICT DO UPDATE command cannot affect row a second time) —
  // on déduplique par clé de conflit, en gardant la dernière occurrence.
  const keys = onConflict.split(',').map((k) => k.trim());
  const dedup = new Map();
  for (const row of rows) {
    dedup.set(keys.map((k) => row[k]).join(' '), row);
  }
  rows = [...dedup.values()];
  if (DRY_RUN) { console.log(`  [dry-run] ${table} : ${rows.length} lignes (non écrites)`); return; }
  // Un upsert de plusieurs milliers de lignes en un seul appel déclenche un
  // statement timeout côté Supabase (57014) — on envoie par lots.
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`Supabase upsert ${table} ${r.status}: ${await r.text()}`);
  }
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

// Réf produits (SKU) des lignes de commande. Structure confirmée en prod :
// order.order_items[] -> { product: { sku, ... }, ... } — le SKU est imbriqué
// sous `product`, pas directement sur la ligne (contrairement à ce qu'on
// supposait avant d'avoir un exemple réel). On garde les anciens noms de
// champs en repli au cas où une autre marketplace renverrait une forme différente.
function extractOrderRefs(o) {
  const lines = pick(o, 'order_items', 'line_items', 'order_lines', 'products', 'items') || [];
  if (!Array.isArray(lines)) return [];
  const refs = lines
    .map((l) => pick(l, 'sku', 'seller_sku', 'product_ref', 'reference') || pick(l.product || {}, 'sku', 'seller_sku', 'product_ref', 'reference'))
    .filter(Boolean);
  return [...new Set(refs.map(String))];
}

function extractSalesOrder(o) {
  const items = pick(o, 'order_items') || [];
  const firstProduct = (Array.isArray(items) && items[0]?.product) || {};
  return {
    id: pick(o, 'id'),
    channel_id: pick(o, 'channel_id'),
    order_reference: pick(o, 'seller_order_id', 'order_reference', 'reference'),
    order_date: pick(o, 'order_date', 'created_at'),
    total_value: Number(pick(o, 'total_amount', 'total', 'total_value', 'grand_total')) || null,
    currency: pick(o, 'currency') || pick(firstProduct, 'currency'),
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

// GET /tickets/{id} enveloppe la ressource dans { data: {...} } et n'embarque PAS le
// corps des messages, seulement leurs IDs (`messages_ids`, confirmé en prod). Le nombre
// de messages suffit pour la priorisation (relances multiples) ; le corps complet
// nécessiterait un appel /messages/{id} par ID, trop coûteux en quota pour la v1 (2000+
// tickets x plusieurs messages) pour une donnée qu'aucun des 3 onglets n'exploite encore.
function extractTicketDetailBody(ticketDetail) {
  return (ticketDetail && typeof ticketDetail.data === 'object' && ticketDetail.data) || ticketDetail || {};
}

function extractTags(t) {
  const tags = pick(t, 'tags') || [];
  if (!Array.isArray(tags)) return [];
  return tags.map((tg) => (typeof tg === 'string' ? tg : pick(tg, 'name'))).filter(Boolean);
}

// ── Main ─────────────────────────────────────────────────────────────

async function syncReferenceData() {
  console.log('▶ Canaux, utilisateurs, groupes de tags, templates, contacts...');
  // Séquentiel (pas Promise.all) + petite pause entre chaque ressource : 6 appels
  // concurrents ont suffi à déclencher un 429 "Out of quota" en prod.
  //
  // NB : /tags ("Tag Items" dans le libellé de la permission accordée) n'est PAS
  // une petite liste de définitions de tags — c'est le journal de chaque
  // application d'un tag sur un ticket, dans tout l'historique du compte
  // (83 500 lignes / 835 pages observées en prod, épuise le quota à chaque run).
  // Pas nécessaire pour la v1 : les tags pertinents par ticket sont déjà
  // embarqués dans la réponse /tickets (ticket.tags -> sav_tickets.tags),
  // utilisés directement par la classification. sav_tags reste vide pour
  // l'instant — à réactiver plus tard uniquement si besoin d'un historique
  // complet des tags appliqués, avec une vraie stratégie de pagination longue.
  async function fetchResource(name, label) {
    try {
      const rows = await edeskListAll(name);
      await sleep(300);
      return rows;
    } catch (e) {
      console.warn(`  ${label}:`, e.message);
      return [];
    }
  }
  const channels = await fetchResource('channels', 'channels');
  const users = await fetchResource('users', 'users');
  const tagGroups = await fetchResource('tag-groups', 'tag-groups');
  const templates = await fetchResource('templates', 'templates');
  const contacts = await fetchResource('contacts', 'contacts');
  await sbUpsert('sav_channels', channels.map(extractChannel), 'id');
  await sbUpsert('sav_users', users.map(extractUser), 'id');
  await sbUpsert('sav_tag_groups', tagGroups.map(extractTagGroup), 'id');
  await sbUpsert('sav_templates', templates.map(extractTemplate), 'id');
  await sbUpsert('sav_contacts', contacts.map(extractContact), 'id');
  console.log(`  ${channels.length} canaux, ${users.length} users, ${tagGroups.length} groupes de tags, ${templates.length} templates, ${contacts.length} contacts.`);
  return { channelsById: new Map(channels.map((c) => [String(pick(c, 'id')), extractChannel(c).name])) };
}

async function syncSalesOrders() {
  const cursor = await getSyncCursor('sales_orders');
  const since = effectiveSince(cursor, SALES_ORDER_LOOKBACK_DAYS);
  console.log(`▶ Sales orders (depuis ${since}, fenêtre max ${SALES_ORDER_LOOKBACK_DAYS}j)...`);
  // filter_created_at_gte sur /sales-orders attend une date (YYYY-MM-DD), pas un
  // timestamp Unix : envoyer l'entier faisait planter le parseur DateTime côté
  // eDesk (500 "Failed to parse time string (<epoch> 00:00:00)"), contrairement
  // à /tickets qui accepte bien ce format date-string sur filter_last_updated_at_gte.
  const params = { filter_created_at_gte: since.slice(0, 10) };
  const orders = await edeskListAll('sales-orders', params).catch((e) => { console.warn('  sales-orders:', e.message); return []; });
  const rows = orders.map(extractSalesOrder).filter((r) => r.id != null);
  await sbUpsert('sav_sales_orders', rows, 'id');
  console.log(`  ${rows.length} commandes.`);

  console.log('▶ Order notes...');
  const notes = await edeskListAll('order-notes', params).catch((e) => { console.warn('  order-notes:', e.message); return []; });
  const noteRows = notes.map(extractOrderNote).filter((r) => r.id != null);
  await sbUpsert('sav_order_notes', noteRows, 'id');
  console.log(`  ${noteRows.length} notes.`);

  const bySalesOrderId = new Map(rows.map((o) => [String(o.id), o]));
  await setSyncCursor('sales_orders', new Date().toISOString());
  return bySalesOrderId;
}

async function syncTicketsAndMessages(channelsById, salesOrdersById) {
  const cursor = await getSyncCursor('tickets');
  const since = effectiveSince(cursor, TICKET_LOOKBACK_DAYS);
  console.log(`▶ Tickets (depuis ${since}, fenêtre max ${TICKET_LOOKBACK_DAYS}j)...`);
  const params = { filter_last_updated_at_gte: since.slice(0, 10) };
  const tickets = await edeskListAll('tickets', params).catch((e) => { console.warn('  tickets:', e.message); return []; });
  console.log(`  ${tickets.length} tickets à traiter.`);

  const ticketRows = [];
  let sample = null;

  for (const raw of tickets) {
    const id = pick(raw, 'id');
    if (id == null) continue;
    const salesOrderId = pick(raw, 'sales_order_id');
    const so = salesOrderId != null ? salesOrdersById.get(String(salesOrderId)) : null;
    const channelId = pick(raw, 'channel_id');

    let messageCount = 0;
    try {
      const detail = await edeskGetSmart(`/tickets/${id}`);
      const body = extractTicketDetailBody(detail);
      const messagesIds = pick(body, 'messages_ids') || [];
      messageCount = Array.isArray(messagesIds) ? messagesIds.length : 0;
    } catch (e) {
      console.warn(`  détail ticket ${id}:`, e.message);
    }
    await sleep(200); // espace les appels /tickets/{id} pour rester sous le quota

    const lastMessageAt = pick(raw, 'last_updated_at', 'updated_at');

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
      last_message_at: lastMessageAt,
      message_count: messageCount,
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
      message_count: messageCount,
      order_value: so?.total_value ?? null,
      order_refs: so?.order_refs ?? [],
      order_reference: so?.order_reference ?? null,
      created_at: pick(raw, 'created_at'),
      updated_at: pick(raw, 'last_updated_at', 'updated_at'),
      last_message_at: lastMessageAt,
      raw,
      synced_at: new Date().toISOString(),
    };
    ticketRows.push(row);
    if (!sample) sample = row;
  }

  await sbUpsert('sav_tickets', ticketRows, 'id');
  await setSyncCursor('tickets', new Date().toISOString());

  console.log(`  ${ticketRows.length} tickets synchronisés.`);
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
