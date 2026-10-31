import type { CommercialProposal, ProposalItem } from '../types.ts';
import { finalizeLinePriceOrigin, linePriceSourceOf } from './proposalLineSource.ts';

/** Каноничные значения для ручной строки без полей «причина/источник» в коротком мастере менеджера. */
export const MANAGER_MANUAL_LINE_REASON = 'ручной ввод менеджера';
export const MANAGER_MANUAL_LINE_DETAIL = 'не из прайса';

export function normalizeManualLineForPersist(
  item: ProposalItem,
  fillEmptyManualMeta = true
): ProposalItem {
  let line = finalizeLinePriceOrigin(item);
  if (linePriceSourceOf(line.priceSource ?? line.source) !== 'manual') {
    return line;
  }
  const reason = (line.priceReason ?? line.priceSourceReason ?? '').trim();
  const detail = (line.priceSourceDetail ?? line.priceSourceDetails ?? '').trim();
  const priceReason = reason || (fillEmptyManualMeta ? MANAGER_MANUAL_LINE_REASON : '');
  const priceSourceDetail = detail || (fillEmptyManualMeta ? MANAGER_MANUAL_LINE_DETAIL : '');
  return finalizeLinePriceOrigin({
    ...line,
    article: line.article ?? '',
    title: line.title ?? '',
    description: line.description ?? '',
    unit: line.unit?.trim() || 'шт.',
    priceBasis: line.priceBasis === 'set' ? 'set' : 'unit',
    quantity: line.quantity > 0 ? line.quantity : 1,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent ?? 0,
    catalogBrand: line.catalogBrand ?? 'klerotech',
    priceReason,
    priceSourceReason: priceReason,
    priceSourceDetail,
    priceSourceDetails: priceSourceDetail
  });
}

export function normalizeProposalForPersist(proposal: CommercialProposal): CommercialProposal {
  if (proposal.status !== 'draft') return proposal;
  const items = (proposal.items ?? []).map(item => normalizeManualLineForPersist(item));
  return { ...proposal, items };
}
