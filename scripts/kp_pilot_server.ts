import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TEMPLATE_CONFIG, INITIAL_PROPOSALS, INITIAL_USERS, getUserPermissions } from '../src/data/mockData.ts';
import type { AuditLogEntry, CommercialProposal, ClientInfo, UserProfile } from '../src/types.ts';
import { ensureReleasedDocumentSnapshot } from '../src/utils/proposalDocumentSnapshot.ts';
import { renderBlankPdf } from './blank_pdf.ts';
import { commitProposalMarkSent } from '../src/utils/proposalSentCommit.ts';
import {
  classifyProposalWrite,
  standingWriteStatus,
  canActorDeleteProposal,
  forbiddenForeignPutItemMutation
} from '../src/utils/proposalWriteGuard.ts';
import { normalizeProposalForPersist } from '../src/utils/proposalPersistNormalize.ts';
import { nextContentRevision } from '../src/utils/proposalContentRevision.ts';
import {
  canUserSeeAllProposals,
  createSession,
  ensureAuthSchema,
  formatClearSessionCookie,
  formatSessionCookie,
  parseCookieToken,
  loadSharedCrmClients,
  isKpSalesWriterLogin,
  profileFromSharedAccount,
  presetForStoredUser,
  resolveSessionUserId,
  revokeSession,
  sanitizeProposalForRole,
  usesSharedAuth,
  verifySharedAppUser,
  verifyUserCredentials
} from './kp_pilot_auth.ts';
import { readManualLineHints, upsertManualLineHintsFromProposals } from './kp_manual_line_hints.ts';
import {
  ensureLocalClientsSchema,
  insertLocalCrmClient,
  mergeClientLists,
  readLocalCrmClients
} from './kp_local_clients.ts';

const PORT = Number(process.env.KP_PILOT_PORT || 8824);
const HOST = '127.0.0.1';
const DB_PATH = resolve(process.env.KP_PILOT_DB || '/Users/elenasol/KleroKP/cabinet/kp_owner.sqlite');
const DIST_DIR = resolve(process.env.KP_PILOT_DIST || join(process.cwd(), 'dist'));

if (DB_PATH.startsWith('/tmp/') || DB_PATH.startsWith('/private/tmp/') || DB_PATH.includes('/var/folders/')) {
  throw new Error(`KP database must not live in a temporary directory: ${DB_PATH}`);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kp_users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    preset_id TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kp_proposals (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    author_id TEXT NOT NULL,
    client_snapshot_json TEXT NOT NULL,
    document_snapshot_json TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kp_versions (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    author_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    total_amount REAL NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kp_audit_log (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    type TEXT,
    timestamp TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS kp_list_hidden (
    user_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    hidden_at TEXT NOT NULL,
    PRIMARY KEY (user_id, proposal_id)
  );
`);
ensureAuthSchema(db);
ensureLocalClientsSchema(db);

if (usesSharedAuth()) {
  const storedUsers = readStoredUsers();
  const withPresets = storedUsers.map(user => (
    user.presetId ? user : { ...user, presetId: presetForStoredUser(user) }
  ));
  if (withPresets.some((user, index) => user.presetId !== storedUsers[index]?.presetId)) {
    writeStoredUsers(withPresets);
  }
}

function readStoredUsers(): UserProfile[] {
  const rows = db.prepare('SELECT payload_json FROM kp_users ORDER BY rowid ASC').all() as Array<{ payload_json: string }>;
  return rows.map(r => JSON.parse(r.payload_json) as UserProfile);
}

function writeStoredUsers(users: UserProfile[]): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO kp_users (id, role, preset_id, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      preset_id = excluded.preset_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  db.exec('BEGIN');
  try {
    for (const user of users) {
      upsert.run(user.id, user.role, user.presetId ?? null, JSON.stringify(user), now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function readHiddenProposalIds(userId: string): string[] {
  const rows = db
    .prepare('SELECT proposal_id FROM kp_list_hidden WHERE user_id = ? ORDER BY hidden_at DESC')
    .all(userId) as Array<{ proposal_id: string }>;
  return rows.map(r => r.proposal_id);
}

function setProposalHidden(userId: string, proposalId: string, hidden: boolean): void {
  if (hidden) {
    db.prepare('INSERT OR REPLACE INTO kp_list_hidden (user_id, proposal_id, hidden_at) VALUES (?, ?, ?)').run(
      userId,
      proposalId,
      new Date().toISOString()
    );
  } else {
    db.prepare('DELETE FROM kp_list_hidden WHERE user_id = ? AND proposal_id = ?').run(userId, proposalId);
  }
}

function readStoredProposals(): CommercialProposal[] {
  const rows = db.prepare('SELECT payload_json FROM kp_proposals ORDER BY rowid ASC').all() as Array<{ payload_json: string }>;
  return rows.map(r => ensureReleasedDocumentSnapshot(JSON.parse(r.payload_json) as CommercialProposal));
}

function writeStoredProposals(
  incoming: CommercialProposal[],
  actor: UserProfile,
  authorSource: 'session' | 'fixture' = 'session'
): CommercialProposal[] {
  const previous = readStoredProposals();
  const prevById = new Map(previous.map(p => [p.id, p]));
  const canSeeAll = canUserSeeAllProposals(actor);

  const seenIds = new Set<string>();
  const dedupedIncoming: CommercialProposal[] = [];
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || seenIds.has(item.id)) continue;
    const prev = prevById.get(item.id);
    // Non-all-access user cannot overwrite or claim another employee's proposal
    if (!canSeeAll && prev && prev.authorId !== actor.id) {
      continue;
    }
    seenIds.add(item.id);
    dedupedIncoming.push(item);
  }

  const mergedIncoming = dedupedIncoming.flatMap(item => {
    const prev = prevById.get(item.id);
    if (classifyProposalWrite(actor, prev) !== 'accept') return prev ? [prev] : [];
    if (prev?.status === 'sent') return [prev];
    const authorId = prev
      ? prev.authorId
      : authorSource === 'fixture'
        ? (item.authorId || actor.id)
        : actor.id;
    const normalized: CommercialProposal = ensureReleasedDocumentSnapshot({
      ...normalizeProposalForPersist(item),
      authorId,
      contentRevision: nextContentRevision(prev, item),
      client: {
        ...item.client,
        source: 'manual'
      },
      templateConfig: item.templateConfig || { ...DEFAULT_TEMPLATE_CONFIG },
      versions: item.versions || [],
      auditLog: item.auditLog || []
    });
    if (actor.role !== 'FULL_ACCESS') {
      return [{
        ...normalized,
        internalExpenses: prev?.internalExpenses ?? { delivery: 0, launch: 0, other: 0 }
      }];
    }
    return [normalized];
  });

  const mergedIds = new Set(mergedIncoming.map(item => item.id));
  const retainedSent = previous.filter(item => item.status === 'sent' && !mergedIds.has(item.id));
  // A sent row is never dropped. FULL_ACCESS may still omit a draft or ready proposal.
  const untouchedOthers = previous.filter(item => {
    if (seenIds.has(item.id)) return false;
    if (item.status === 'sent') return true;
    if (actor.role === 'FULL_ACCESS' || actor.presetId === 'admin') return false;
    if (item.authorId !== actor.id) return true;
    if (item.status === 'draft') return false;
    return true;
  });

  const combined = [...mergedIncoming, ...retainedSent, ...untouchedOthers];
  const committed = commitProposalMarkSent(previous, combined);
  const now = new Date().toISOString();

  const insertProposal = db.prepare(`
    INSERT OR REPLACE INTO kp_proposals (
      id, number, version, status, author_id, client_snapshot_json, document_snapshot_json, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT OR REPLACE INTO kp_versions (
      id, proposal_id, version, status, timestamp, author_id, summary, total_amount, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAudit = db.prepare(`
    INSERT OR REPLACE INTO kp_audit_log (
      id, proposal_id, version, type, timestamp, user_id, user_name, action, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM kp_proposals');
    db.exec('DELETE FROM kp_versions');
    for (const proposal of committed) {
      insertProposal.run(
        proposal.id,
        proposal.number,
        proposal.version,
        proposal.status,
        proposal.authorId,
        JSON.stringify(proposal.client),
        proposal.documentSnapshot ? JSON.stringify(proposal.documentSnapshot) : null,
        JSON.stringify(proposal),
        now
      );
      for (const ver of proposal.versions || []) {
        insertVersion.run(
          `${proposal.id}:${ver.id}`,
          proposal.id,
          ver.version,
          ver.status,
          ver.timestamp,
          ver.authorId,
          ver.summary,
          ver.totalAmount,
          JSON.stringify(ver)
        );
      }
      for (const entry of (proposal.auditLog || []) as Array<AuditLogEntry & { type?: string; version?: number }>) {
        insertAudit.run(
          `${proposal.id}:${entry.id}`,
          proposal.id,
          entry.version ?? proposal.version,
          entry.type ?? null,
          entry.timestamp,
          entry.userId,
          entry.userName,
          entry.action,
          entry.details ?? null
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  upsertManualLineHintsFromProposals(db, committed);

  return committed;
}

function proposalForBlankPdf(
  allProposals: CommercialProposal[],
  actor: UserProfile,
  id: string,
  contentRevision: number,
  versionHint?: number
): CommercialProposal | undefined {
  const current = visibleProposalsForActor(allProposals, actor).find(item => item.id === id);
  if (!current) return undefined;
  const storedRev = current.contentRevision ?? 1;
  if (storedRev !== contentRevision) return undefined;
  if (typeof versionHint === 'number' && Number.isInteger(versionHint) && current.version !== versionHint) {
    return undefined;
  }
  return current;
}

function visibleProposalsForActor(allProposals: CommercialProposal[], actor: UserProfile): CommercialProposal[] {
  const canSeeAll = canUserSeeAllProposals(actor);
  const filtered = canSeeAll ? allProposals : allProposals.filter(p => p.authorId === actor.id);
  return filtered.map(p => sanitizeProposalForRole(p, actor.role));
}

/** Клиент видит sanitizeProposalForRole и не может перезаписать чужие/sent — подставляем канон из SQLite до write-guard. */
function augmentProposalsPutPayload(
  actor: UserProfile,
  storedAll: CommercialProposal[],
  clientIncoming: CommercialProposal[]
): CommercialProposal[] {
  const prevById = new Map(storedAll.map(p => [p.id, p]));
  const visibleIds = new Set(visibleProposalsForActor(storedAll, actor).map(p => p.id));
  const reconciled = clientIncoming.flatMap(item => {
    if (!item || typeof item.id !== 'string') return [];
    const prev = prevById.get(item.id);
    if (prev && (classifyProposalWrite(actor, prev) !== 'accept' || prev.status === 'sent')) {
      return [prev];
    }
    return [item];
  });
  const resultIds = new Set(reconciled.map(p => p.id));
  for (const prev of storedAll) {
    if (resultIds.has(prev.id)) continue;
    if (!visibleIds.has(prev.id)) {
      reconciled.push(prev);
    }
  }
  return reconciled;
}

function repairSalesWriterProfiles(): void {
  const users = readStoredUsers();
  let changed = false;
  const nextUsers = users.map(user => {
    if (!isKpSalesWriterLogin(user.id)) return user;
    const profile = profileFromSharedAccount({
      login: user.id,
      displayName: user.name,
      role: 'MANAGER',
      mcrmRole: 'MANAGER'
    });
    if (user.role === profile.role && user.presetId === profile.presetId && user.title === profile.title) {
      return user;
    }
    changed = true;
    return {
      ...user,
      name: profile.name || user.name,
      role: profile.role,
      title: profile.title,
      presetId: profile.presetId,
      permissions: getUserPermissions({ ...user, role: profile.role, presetId: profile.presetId })
    };
  });
  if (changed) writeStoredUsers(nextUsers);
}

function seedIfEmpty(): void {
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM kp_users').get() as { c: number }).c;
  if (userCount === 0) {
    writeStoredUsers(INITIAL_USERS);
  }
  const proposalCount = (db.prepare('SELECT COUNT(*) as c FROM kp_proposals').get() as { c: number }).c;
  if (proposalCount === 0) {
    const initial = INITIAL_PROPOSALS.map(p => ensureReleasedDocumentSnapshot({
      ...p,
      client: { ...p.client, source: 'manual' },
      templateConfig: p.templateConfig || { ...DEFAULT_TEMPLATE_CONFIG },
      versions: p.versions || [],
      auditLog: p.auditLog || []
    }));
    const directorActor = INITIAL_USERS.find(u => u.role === 'FULL_ACCESS') || INITIAL_USERS[0];
    writeStoredProposals(initial, directorActor, 'fixture');
  }
}

seedIfEmpty();
repairSalesWriterProfiles();

function resolveAuthenticatedUser(req: IncomingMessage): UserProfile | null {
  // Never trust x-kp-user-id, query userId, or any client-supplied role.
  // Only the server-side session token from the HttpOnly cookie is accepted.
  const token = parseCookieToken(req.headers.cookie);
  const userId = resolveSessionUserId(db, token);
  if (!userId) return null;
  const users = readStoredUsers();
  const matched = users.find(u => u.id === userId && u.active !== false);
  return matched || null;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders?: Record<string, string>): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  });
  res.end(body);
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    // Minimal health-check: no roles, no document counts, no DB paths, no internal details.
    if (req.method === 'GET' && url.pathname === '/api/kp/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/kp/auth/login') {
      const body = (await readJsonBody(req)) as { login?: string; password?: string };
      const loginInput = String(body.login || '').trim();
      const passwordInput = String(body.password || '');
      if (!loginInput || !passwordInput) {
        sendJson(res, 400, { error: 'Укажите логин (ID или email) и пароль' });
        return;
      }
      const users = readStoredUsers();
      let targetUser: UserProfile | undefined;
      if (usesSharedAuth()) {
        let shared: ReturnType<typeof verifySharedAppUser>;
        try {
          shared = verifySharedAppUser(loginInput, passwordInput);
        } catch {
          sendJson(res, 503, { error: 'Общая авторизация сейчас недоступна' });
          return;
        }
        if (!shared) {
          sendJson(res, 401, { error: 'Неверный логин или пароль' });
          return;
        }
        const next = profileFromSharedAccount(shared);
        const idx = users.findIndex(u => u.id === next.id);
        if (idx === -1) {
          writeStoredUsers([...users, next]);
        } else {
          const merged = {
            ...users[idx],
            name: next.name,
            role: next.role,
            title: next.title,
            presetId: next.presetId,
            active: true
          };
          const copy = users.slice();
          copy[idx] = merged;
          writeStoredUsers(copy);
        }
        targetUser = readStoredUsers().find(u => u.id === next.id);
      } else {
        targetUser = users.find(
          u =>
            u.active !== false &&
            (u.id === loginInput ||
              u.email.toLowerCase() === loginInput.toLowerCase() ||
              u.name.toLowerCase() === loginInput.toLowerCase())
        );
        if (!targetUser || !verifyUserCredentials(db, targetUser.id, passwordInput)) {
          targetUser = undefined;
        }
      }
      if (!targetUser) {
        sendJson(res, 401, { error: 'Неверный логин или пароль' });
        return;
      }
      const token = createSession(db, targetUser.id);
      sendJson(
        res,
        200,
        {
          actor: targetUser
        },
        {
          'Set-Cookie': formatSessionCookie(token)
        }
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/kp/auth/logout') {
      const token = parseCookieToken(req.headers.cookie);
      revokeSession(db, token);
      sendJson(
        res,
        200,
        { status: 'logged_out' },
        {
          'Set-Cookie': formatClearSessionCookie()
        }
      );
      return;
    }

    if (url.pathname.startsWith('/api/kp/')) {
      const actor = resolveAuthenticatedUser(req);
      if (!actor) {
        sendJson(res, 401, { error: 'Требуется авторизация' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/kp/blank-pdf') {
        const body = (await readJsonBody(req)) as { id?: unknown; version?: unknown; contentRevision?: unknown };
        const id = typeof body.id === 'string' ? body.id : '';
        const contentRevision =
          typeof body.contentRevision === 'number' && Number.isInteger(body.contentRevision)
            ? body.contentRevision
            : Number.NaN;
        const versionHint =
          typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : undefined;
        if (!id || !Number.isInteger(contentRevision)) {
          sendJson(res, 400, { error: 'id and contentRevision required' });
          return;
        }
        const stored = proposalForBlankPdf(readStoredProposals(), actor, id, contentRevision, versionHint);
        if (!stored) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        try {
          const pdf = renderBlankPdf(stored);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="kp.pdf"',
            'Cache-Control': 'no-store'
          });
          res.end(pdf);
        } catch {
          console.error('blank pdf failed');
          sendJson(res, 500, { error: 'pdf failed' });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/kp/bootstrap') {
        const users = readStoredUsers();
        const proposals = visibleProposalsForActor(readStoredProposals(), actor);
        let sharedClients: ReturnType<typeof loadSharedCrmClients> = [];
        if (usesSharedAuth()) {
          try {
            sharedClients = loadSharedCrmClients(actor);
          } catch {
            console.error('crm client lookup failed');
          }
        }
        const localClients = readLocalCrmClients(db, actor);
        const clients = mergeClientLists(sharedClients, localClients);
        sendJson(res, 200, {
          actor,
          users: actor.role === 'FULL_ACCESS' ? users : [actor],
          proposals,
          clients,
          hiddenProposalIds: readHiddenProposalIds(actor.id),
          manualLineHints: readManualLineHints(db)
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/kp/clients') {
        const body = (await readJsonBody(req)) as Partial<ClientInfo>;
        const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
        const contactPerson = typeof body.contactPerson === 'string' ? body.contactPerson.trim() : '';
        if (!companyName || !contactPerson) {
          sendJson(res, 400, { error: 'companyName and contactPerson required' });
          return;
        }
        const saved = insertLocalCrmClient(db, actor, body as ClientInfo);
        const sharedClients = usesSharedAuth() ? loadSharedCrmClients(actor) : [];
        const clients = mergeClientLists(sharedClients, readLocalCrmClients(db, actor));
        sendJson(res, 200, { client: saved, clients });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/kp/list-hidden') {
        const body = (await readJsonBody(req)) as { proposalId?: unknown; hidden?: unknown };
        const proposalId = typeof body.proposalId === 'string' ? body.proposalId : '';
        const hidden = body.hidden === true;
        if (!proposalId) {
          sendJson(res, 400, { error: 'proposalId required' });
          return;
        }
        const visible = visibleProposalsForActor(readStoredProposals(), actor);
        if (!visible.some(p => p.id === proposalId)) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        setProposalHidden(actor.id, proposalId, hidden);
        sendJson(res, 200, { hiddenProposalIds: readHiddenProposalIds(actor.id) });
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/kp/proposals') {
        const body = (await readJsonBody(req)) as { proposals?: CommercialProposal[] };
        if (!Array.isArray(body.proposals)) {
          sendJson(res, 400, { error: 'proposals array required' });
          return;
        }
        const storedAll = readStoredProposals();
        const prevById = new Map(storedAll.map(p => [p.id, p]));
        for (const item of body.proposals) {
          if (!item || typeof item.id !== 'string') continue;
          const prev = prevById.get(item.id);
          if (!prev) continue;
          const visibleCopy = sanitizeProposalForRole(prev, actor.role);
          if (forbiddenForeignPutItemMutation(actor, prev, item, visibleCopy)) {
            sendJson(res, 403, {
              error: 'Запись КП запрещена',
              proposals: visibleProposalsForActor(storedAll, actor)
            });
            return;
          }
        }
        const guardedPayload = augmentProposalsPutPayload(actor, storedAll, body.proposals);
        const verdict = standingWriteStatus(actor, storedAll, guardedPayload);
        if (verdict !== 200) {
          sendJson(res, verdict, {
            error: verdict === 422 ? 'КП не проходит обязательную проверку' : 'Запись КП запрещена',
            proposals: visibleProposalsForActor(storedAll, actor)
          });
          return;
        }
        if (actor.role === 'FULL_ACCESS') {
          const incomingIds = new Set(guardedPayload.map(item => item?.id).filter((id): id is string => typeof id === 'string' && id.length > 0));
          const dropsForeign = storedAll.some(item => !incomingIds.has(item.id) && item.authorId !== actor.id);
          if (dropsForeign) {
            sendJson(res, 403, {
              error: 'Запись КП запрещена',
              proposals: visibleProposalsForActor(storedAll, actor)
            });
            return;
          }
        }
        const saved = writeStoredProposals(guardedPayload, actor);
        sendJson(res, 200, {
          proposals: visibleProposalsForActor(saved, actor),
          manualLineHints: readManualLineHints(db)
        });
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/kp/users') {
        if (actor.role !== 'FULL_ACCESS') {
          sendJson(res, 403, { error: 'FULL_ACCESS required' });
          return;
        }
        const body = (await readJsonBody(req)) as { users?: UserProfile[] };
        if (!Array.isArray(body.users)) {
          sendJson(res, 400, { error: 'users array required' });
          return;
        }
        writeStoredUsers(body.users);
        sendJson(res, 200, { users: readStoredUsers() });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // Serve static SPA from DIST_DIR
    const safeRel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = join(DIST_DIR, safeRel === '/' ? 'index.html' : safeRel);
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(DIST_DIR, 'index.html');
    }
    const ext = extname(filePath);
    const content = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal Server Error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[wave1a-kp-pilot] listening on http://${HOST}:${PORT}`);
});
