import type { CommercialProposal } from '../types.ts';
import { preflightDraftProposal, type DraftPreflightInput } from './draftPreflight.ts';

export type ProposalWriteDecision = 'reject-actor' | 'keep-stored' | 'accept';

export function canActorDeleteProposal(
  actor: { id: string; presetId?: string; role?: string },
  previous: { authorId: string; status?: string }
): boolean {
  if (previous.status === 'sent') return false;
  if (actor.presetId === 'top_manager' || actor.presetId === 'service_engineer') return false;
  if (actor.presetId === 'admin' || actor.role === 'FULL_ACCESS') return true;
  return previous.authorId === actor.id && previous.status === 'draft';
}

export function classifyProposalWrite(
  actor: { id: string; presetId?: string },
  previous: { authorId: string; status?: string } | undefined
): ProposalWriteDecision {
  if (actor.presetId === 'top_manager' || actor.presetId === 'service_engineer') return 'reject-actor';
  if (previous?.status === 'sent') return 'keep-stored';
  if (previous && previous.authorId !== actor.id) return 'keep-stored';
  return 'accept';
}

export function editorMutationsAllowed(
  actor: { id: string; presetId?: string },
  proposal: { authorId?: string }
): boolean {
  if (actor.presetId === 'top_manager' || actor.presetId === 'service_engineer') return false;
  if (proposal.authorId && proposal.authorId !== actor.id && actor.presetId !== 'admin') return false;
  return true;
}

export function proposalWriteStamp(proposal: {
  id?: string;
  status?: string;
  authorId?: string;
  number?: string;
  client?: { companyName?: string; contactPerson?: string };
  items?: Array<{ title?: string; quantity?: number; unitPrice?: number; discountPercent?: number }>;
}): string {
  return JSON.stringify({
    id: proposal.id ?? '',
    status: proposal.status ?? '',
    authorId: proposal.authorId ?? '',
    number: proposal.number ?? '',
    company: proposal.client?.companyName ?? '',
    contact: proposal.client?.contactPerson ?? '',
    items: (proposal.items ?? []).map(item => ({
      title: item.title ?? '',
      quantity: item.quantity ?? 0,
      unitPrice: item.unitPrice ?? 0,
      discountPercent: item.discountPercent ?? 0
    }))
  });
}

const KNOWN_WRITE_PRESETS = new Set(['admin', 'top_manager', 'office_spb', 'regional_manager', 'service_engineer']);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function proposalWriteEchoStamp(proposal: object, role?: string): string {
  return echoStamp(proposal, role);
}

/** Запрещённая подмена чужого/sent в теле PUT (не sanitize-вид из bootstrap). */
export function forbiddenForeignPutItemMutation(
  actor: { id: string; presetId?: string; role?: string },
  prev: CommercialProposal,
  clientItem: CommercialProposal,
  clientVisibleCopy: CommercialProposal
): boolean {
  if (classifyProposalWrite(actor, prev) === 'accept') return false;
  const echo = (p: object) => echoStamp(p, actor.role);
  if (echo(clientItem) === echo(prev)) return false;
  if (echo(clientItem) === echo(clientVisibleCopy)) return false;
  return true;
}

function echoStamp(proposal: object, role?: string): string {
  const copy = structuredClone(proposal) as Record<string, unknown>;
  delete copy.updatedAt;
  if (role !== 'FULL_ACCESS') {
    const zeroExpenses = { delivery: 0, launch: 0, other: 0 };
    copy.internalExpenses = zeroExpenses;
    const snapshot = copy.documentSnapshot as { expenses?: unknown; lines?: Array<Record<string, unknown>> } | undefined;
    if (snapshot) {
      snapshot.expenses = { ...zeroExpenses, total: 0 };
      snapshot.lines = (snapshot.lines || []).map(line => ({ ...line, allocatedExpense: 0 }));
    }
    copy.versions = ((copy.versions as Array<Record<string, unknown>>) || []).map(version => {
      const data = version.snapshotData as Record<string, unknown> | undefined;
      if (!data) return version;
      const nested = data.documentSnapshot as { expenses?: unknown; lines?: Array<Record<string, unknown>> } | undefined;
      return {
        ...version,
        snapshotData: {
          ...data,
          internalExpenses: zeroExpenses,
          documentSnapshot: nested
            ? {
                ...nested,
                expenses: { ...zeroExpenses, total: 0 },
                lines: (nested.lines || []).map(line => ({ ...line, allocatedExpense: 0 }))
              }
            : data.documentSnapshot
        }
      };
    });
  }
  return stableJson(copy);
}

export function standingWriteStatus(
  actor: { id: string; presetId?: string; role?: string },
  previous: Array<{ id: string; authorId: string; status?: string }>,
  incoming: Array<DraftPreflightInput & { id: string; authorId?: string }>
): 200 | 403 | 422 {
  if (!actor.presetId || !KNOWN_WRITE_PRESETS.has(actor.presetId)) return 403;
  const prevById = new Map(previous.map(item => [item.id, item]));
  const incomingIds = new Set(incoming.map(item => item?.id).filter((id): id is string => typeof id === 'string'));
  let forbidden = false;
  let invalid = false;
  for (const prev of previous) {
    if (incomingIds.has(prev.id)) continue;
    if (prev.status === 'sent') continue;
    if (!canActorDeleteProposal(actor, prev)) {
      forbidden = true;
    }
  }
  for (const item of incoming) {
    const prev = prevById.get(item.id);
    const decision = classifyProposalWrite(actor, prev);
    if (decision !== 'accept') {
      if (!prev || echoStamp(prev, actor.role) !== echoStamp(item, actor.role)) forbidden = true;
      continue;
    }
    if ((item.status === 'ready' || item.status === 'sent') && !releaseStatusAllowed(item)) {
      invalid = true;
    }
  }
  if (forbidden) return 403;
  if (invalid) return 422;
  return 200;
}

export function releaseStatusAllowed(proposal: DraftPreflightInput): boolean {
  if (proposal.status !== 'ready' && proposal.status !== 'sent') return true;
  return preflightDraftProposal({ ...proposal, status: 'draft' }).length === 0;
}
