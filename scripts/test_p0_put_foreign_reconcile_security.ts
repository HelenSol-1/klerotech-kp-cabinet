#!/usr/bin/env npx tsx
/**
 * Security regression: augmentProposalsPutPayload + foreign tamper guard.
 * Requires live kp_pilot_server on :3010 and KP_PILOT_DB (default kp_owner.sqlite).
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CommercialProposal, UserProfile } from '../src/types.ts';
import { classifyProposalWrite } from '../src/utils/proposalWriteGuard.ts';
import { normalizeProposalForPersist } from '../src/utils/proposalPersistNormalize.ts';

const base = process.env.KP_PILOT_BASE || 'http://127.0.0.1:3010';
const dbPath = process.env.KP_PILOT_DB || '/Users/elenasol/KleroKP/cabinet/kp_owner.sqlite';

const jar = new Map<string, string>();

function parseSetCookie(header: string | null) {
  if (!header) return;
  for (const chunk of header.split(/,(?=\s*[^;]+=)/)) {
    const part = chunk.split(';')[0]?.trim();
    if (!part) continue;
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Cookie: cookieHeader(),
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  parseSetCookie(res.headers.get('set-cookie'));
  return res;
}

function readPayloadBytesById(): Map<string, string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT id, payload_json FROM kp_proposals').all() as Array<{
    id: string;
    payload_json: string;
  }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.id, row.payload_json);
  }
  return map;
}

function sha256(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildAppPutPayload(
  actor: UserProfile,
  proposals: CommercialProposal[],
  serverProposals: CommercialProposal[]
): CommercialProposal[] {
  const serverById = new Map(serverProposals.map(p => [p.id, p]));
  const payloadById = new Map<string, CommercialProposal>();
  for (const p of proposals) {
    const stored = serverById.get(p.id);
    if (stored?.status === 'sent') {
      payloadById.set(p.id, stored);
      continue;
    }
    if (stored && classifyProposalWrite(actor, stored) !== 'accept') {
      payloadById.set(p.id, stored);
      continue;
    }
    if (stored && p.status === 'sent') {
      payloadById.set(p.id, stored);
      continue;
    }
    payloadById.set(p.id, normalizeProposalForPersist(p));
  }
  for (const stored of serverProposals) {
    if (!payloadById.has(stored.id)) payloadById.set(stored.id, stored);
  }
  return [...payloadById.values()];
}

function foreignIds(all: Map<string, string>, ownerId: string): string[] {
  const out: string[] = [];
  for (const [id, json] of all) {
    const p = JSON.parse(json) as CommercialProposal;
    if (p.authorId !== ownerId) out.push(id);
  }
  return out;
}

const failures: string[] = [];
function assert(name: string, ok: boolean, detail?: string) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const bytesBefore = readPayloadBytesById();

const login = await req('/api/kp/auth/login', {
  method: 'POST',
  body: JSON.stringify({ login: 'testo', password: '1111' })
});
assert('login testo', login.status === 200, String(login.status));

const boot = await req('/api/kp/bootstrap');
assert('bootstrap', boot.ok);
const bootData = (await boot.json()) as {
  actor: UserProfile;
  proposals: CommercialProposal[];
};
const actor = bootData.actor;
assert('testo canAccessAllKp (office_spb)', actor.presetId === 'office_spb');

const visible = bootData.proposals;
const ownDraft =
  visible.find(p => p.authorId === actor.id && p.status === 'draft' && p.number === 'КП-2026-0015') ||
  visible.find(p => p.authorId === actor.id && p.status === 'draft');
const foreignDraft = visible.find(p => p.authorId !== actor.id && p.status === 'draft');
assert('fixture own draft', Boolean(ownDraft), ownDraft?.number);
assert('fixture foreign draft in visible set', Boolean(foreignDraft), foreignDraft?.number);

if (!ownDraft || !foreignDraft) {
  console.error('\n🔴 SECURITY REGRESSION ABORT — missing fixtures\n');
  process.exit(1);
}

const marker = `SEC-P0-${Date.now()}`;
const clientProposals = visible.map(p => {
  if (p.id !== ownDraft.id) return p;
  const line = p.items?.[0];
  if (!line) return p;
  return {
    ...p,
    items: [{ ...line, title: marker, unitPrice: line.unitPrice > 0 ? line.unitPrice : 100 }]
  };
});

const legitPayload = buildAppPutPayload(actor, clientProposals, visible);
assert(
  'payload includes foreign sanitized rows',
  legitPayload.some(p => p.id === foreignDraft.id),
  foreignDraft.number
);

const foreignBefore = foreignIds(bytesBefore, actor.id);
const foreignHashesBefore = new Map(
  foreignBefore.map(id => [id, sha256(bytesBefore.get(id) ?? '')])
);

const putOk = await req('/api/kp/proposals', {
  method: 'PUT',
  body: JSON.stringify({ proposals: legitPayload })
});
assert('legitimate PUT with own edit + foreign copies', putOk.status === 200, String(putOk.status));

const bytesAfterLegit = readPayloadBytesById();
const ownJson = bytesAfterLegit.get(ownDraft.id);
const ownParsed = ownJson ? (JSON.parse(ownJson) as CommercialProposal) : null;
assert(
  'server persisted own draft line',
  ownParsed?.items?.[0]?.title === marker,
  ownParsed?.items?.[0]?.title
);

for (const id of foreignBefore) {
  const before = bytesBefore.get(id);
  const after = bytesAfterLegit.get(id);
  assert(
    `foreign byte-identical after legit PUT (${id})`,
    before !== undefined && before === after,
    before === after ? 'match' : `hash ${sha256(before ?? '')} → ${sha256(after ?? '')}`
  );
}

const tamperPayload = legitPayload.map(p => {
  if (p.id !== foreignDraft.id) return p;
  return {
    ...p,
    client: { ...p.client, companyName: `TAMPER-${marker}` }
  };
});

const putForbidden = await req('/api/kp/proposals', {
  method: 'PUT',
  body: JSON.stringify({ proposals: tamperPayload })
});
assert('tampered foreign in payload → 403', putForbidden.status === 403, String(putForbidden.status));

const bytesAfterTamper = readPayloadBytesById();
for (const [id, json] of bytesAfterLegit) {
  const afterTamper = bytesAfterTamper.get(id);
  assert(
    `no DB change after 403 tamper (${id})`,
    json === afterTamper,
    id === ownDraft.id ? 'own row' : 'foreign/other'
  );
}

for (const id of foreignBefore) {
  assert(
    `foreign still byte-identical to initial after 403 (${id})`,
    bytesBefore.get(id) === bytesAfterTamper.get(id)
  );
}

console.log('----------------------------------------------------');
if (failures.length === 0) {
  console.log('\n🟢 P0 PUT foreign reconcile security: ALL PASS\n');
  process.exit(0);
}
console.error(`\n🔴 FAILURES: ${failures.join(', ')}\n`);
process.exit(1);
