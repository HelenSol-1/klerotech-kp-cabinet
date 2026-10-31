import React, { useState, useEffect } from 'react';
import { 
  CommercialProposal, 
  ProposalItem, 
  EngineerWorkItem, 
  UserProfile, 
  BlankType, 
  ProposalType, 
  PriceBasis,
  PriceSource,
  ClientInfo,
  ProposalTemplateConfig,
  ProposalVersionSnapshot
} from '../types.ts';
import { calculateProposalTotals, formatCurrency, DEFAULT_TEMPLATE_CONFIG } from '../data/mockData.ts';
import { 
  Plus, 
  Trash2, 
  FileDown, 
  Save, 
  BookOpen, 
  ArrowLeft, 
  CheckCircle, 
  AlertTriangle, 
  Sparkles, 
  Eye, 
  Mail, 
  Copy, 
  ShieldAlert, 
  Layers,
  HelpCircle,
  Truck,
  Wrench,
  Percent,
  Check,
  Building2,
  History,
  Sliders,
  RotateCcw,
  CreditCard,
  GitCompare,
  Split,
  AlertCircle,
  ShieldCheck,
  MoreHorizontal
} from 'lucide-react';
import { exportProposalToExcel, INTERNAL_EXCEL_LABEL } from '../utils/excelExport.ts';
import { isProposalEditorActionAllowed, type ProposalEditorAction } from '../utils/proposalLifecycle.ts';
import { canActorDeleteProposal } from '../utils/proposalWriteGuard.ts';
import { isProposalDirty } from '../utils/proposalContentRevision.ts';
import { normalizeProposalForPersist } from '../utils/proposalPersistNormalize.ts';
import { proposalWriteStamp } from '../utils/proposalWriteGuard.ts';
import { matchManualLineHint, type ManualLineHint } from '../utils/manualLineHints.ts';
import { parseDecimalString, parseDiscountDigits, sanitizeDecimalString, sanitizeDigitString } from '../utils/kpNumericField.ts';
import { isManagerWizardUser, type ManagerWizardStep } from '../utils/kpManagerWizard.ts';
import { clientAfterCompanyRename, proposalClientFromCrm } from '../utils/proposalClientSnapshot.ts';
import { applyExplicitLineSource, finalizeLinePriceOrigin, linePriceSourceOf, sourceForNewLine } from '../utils/proposalLineSource.ts';
import { KLEROTECH_PRICE_LIST_VERSION, ROBATECH_PRICE_LIST_VERSION } from '../data/priceLists.ts';
import { applyLineAmountEdit, confirmSetLineAmount, lineAmountNeedsConfirmation, lineBaseAmount } from '../utils/proposalLineAmount.ts';
import { DRAFT_LINE_ERROR_TEXT, draftLineError, validateDraftLine, type DraftLineField } from '../utils/draftLineValidation.ts';
import { draftLineNumber, removeDraftProposalLine, removeLineById } from '../utils/draftLineRemoval.ts';
import { applyDirectorViewEdit, directorProposalView, directorTemplateSurface, documentForReading, readDirectorDocument, viewProjection } from '../utils/proposalDocumentSnapshot.ts';
import { appendProposalAudit, type ProposalAuditType } from '../utils/proposalAudit.ts';
import { PriceBookDrawer } from './PriceBookDrawer.tsx';
import { CrmClientModal } from './CrmClientModal.tsx';
import { VersionHistoryDrawer } from './VersionHistoryDrawer.tsx';
import { TemplateSettingsModal } from './TemplateSettingsModal.tsx';
import { PriceReconciliationModal } from './PriceReconciliationModal.tsx';
import { KpWizardClientStep } from './KpWizardClientStep.tsx';
import { KpWizardReviewStep } from './KpWizardReviewStep.tsx';

interface ProposalEditorProps {
  proposal: CommercialProposal;
  persistedProposal?: CommercialProposal;
  currentUser: UserProfile;
  clients: ClientInfo[];
  onAddNewClient: (client: ClientInfo) => void | Promise<ClientInfo | null | void>;
  onSave: (updated: CommercialProposal) => void;
  onBack: () => void;
  onReleasePdf: (proposal: CommercialProposal) => void;
  onPreviewPdf?: (proposal: CommercialProposal) => void;
  onDownloadPdf?: (proposal: CommercialProposal) => void;
  onOpenPdf: (proposal: CommercialProposal) => void;
  onOpenEmailText: (proposal: CommercialProposal) => void;
  onCreateNewVersion: (proposal: CommercialProposal) => void;
  onDelete: (proposalId: string) => void;
  onMarkAsSent: (proposalId: string) => void;
  onSplitProposal?: (proposal: CommercialProposal) => void;
  templateOpen?: boolean;
  editorFocus?: { field: string; itemId?: string } | null;
  manualLineHints?: ManualLineHint[];
  /** false = в модалке клиента только закреплённые (режим «Мои» в списке КП) */
  kpClientScopeAll?: boolean;
}

// Dedicated robust DiscountInput component that solves the backspace/stuck discount bug
interface DiscountInputProps {
  value: number;
  onChange: (val: number) => void;
  className?: string;
  locked?: boolean;
}

const DiscountInput: React.FC<DiscountInputProps> = ({ value, onChange, className, locked = false }) => {
  const [localStr, setLocalStr] = useState<string>(value > 0 ? String(value) : '');
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setLocalStr(value > 0 ? String(value) : '');
    }
  }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (locked) return;
    const digits = sanitizeDigitString(e.target.value);
    setLocalStr(digits);
    onChange(parseDiscountDigits(digits, false));
  };

  const handleBlur = () => {
    setIsFocused(false);
    const finalVal = parseDiscountDigits(localStr, true);
    setLocalStr(finalVal > 0 ? String(finalVal) : '');
    onChange(finalVal);
  };

  return (
    <div className="space-y-1">
      <div className="relative flex items-center">
        <input
          type="text"
          inputMode="numeric"
          placeholder=""
          value={isFocused ? localStr : value > 0 ? String(value) : ''}
          onFocus={e => {
            setIsFocused(true);
            setLocalStr(value > 0 ? String(value) : '');
            requestAnimationFrame(() => e.target.select());
          }}
          onBlur={handleBlur}
          onChange={handleChange}
          readOnly={locked}
          className={`${className || 'w-full text-xs font-bold p-1.5 bg-white border border-black rounded-lg text-center'} ${
            value > 20 ? 'bg-amber-50 border-amber-500 text-amber-950 font-black ring-1 ring-amber-400' : ''
          }`}
        />
        <span className="absolute right-2 text-[10px] text-slate-400 font-bold pointer-events-none">%</span>
      </div>
    </div>
  );
};

interface DecimalInputProps {
  value: number;
  onChange: (val: number) => void;
  className?: string;
  locked?: boolean;
}

const DecimalInput: React.FC<DecimalInputProps> = ({ value, onChange, className, locked = false }) => {
  const [localStr, setLocalStr] = useState(value > 0 ? String(value) : '');
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setLocalStr(value > 0 ? String(value) : '');
    }
  }, [value, isFocused]);

  return (
    <input
      type="text"
      inputMode="decimal"
      placeholder=""
      readOnly={locked}
      value={isFocused ? localStr : value > 0 ? String(value) : ''}
      onFocus={e => {
        setIsFocused(true);
        setLocalStr(value > 0 ? String(value) : '');
        requestAnimationFrame(() => e.target.select());
      }}
      onBlur={() => {
        setIsFocused(false);
        const finalVal = parseDecimalString(localStr, true);
        setLocalStr(finalVal > 0 ? String(finalVal) : '');
        onChange(finalVal);
      }}
      onChange={e => {
        if (locked) return;
        const next = sanitizeDecimalString(e.target.value);
        setLocalStr(next);
        onChange(parseDecimalString(next, false));
      }}
      className={className}
    />
  );
};

export const ProposalEditor: React.FC<ProposalEditorProps> = ({
  proposal: initialProposal,
  persistedProposal,
  currentUser,
  clients,
  onAddNewClient,
  onSave,
  onBack,
  onReleasePdf,
  onPreviewPdf,
  onDownloadPdf,
  onOpenPdf,
  onOpenEmailText,
  onCreateNewVersion,
  onDelete,
  onMarkAsSent,
  onSplitProposal,
  templateOpen = false,
  editorFocus = null,
  manualLineHints = [],
  kpClientScopeAll = true
}) => {
  const [proposal, setProposal] = useState<CommercialProposal>(initialProposal);
  useEffect(() => {
    if (!editorFocus) return;
    const selector = editorFocus.itemId
      ? `[data-kp-item="${editorFocus.itemId}"][data-kp-field="${editorFocus.field}"]`
      : `[data-kp-field="${editorFocus.field}"]`;
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) return;
    node.scrollIntoView({ block: 'center' });
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
      node.focus();
    }
  }, [editorFocus]);
  const [isPriceBookOpen, setIsPriceBookOpen] = useState(false);
  const [isCrmModalOpen, setIsCrmModalOpen] = useState(false);
  const [crmModalMode, setCrmModalMode] = useState<'list' | 'create'>('list');
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(templateOpen);
  const [isReconciliationOpen, setIsReconciliationOpen] = useState(false);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  /** Мастер Aura — только менеджеры в черновике; FULL_ACCESS и ready/sent — полная/снимковая форма. */
  const managerWizard =
    isManagerWizardUser(currentUser) &&
    initialProposal.status === 'draft' &&
    currentUser.role === 'MANAGER';
  const [wizardStep, setWizardStep] = useState<ManagerWizardStep>(1);
  const foreignLocked = Boolean(initialProposal.authorId) && initialProposal.authorId !== currentUser.id;
  const sentLocked = foreignLocked || !isProposalEditorActionAllowed(initialProposal.status, 'save');
  const allowEditorAction = (action: ProposalEditorAction) =>
    !foreignLocked && isProposalEditorActionAllowed(initialProposal.status, action);
  const savedOnServer = persistedProposal;
  const hasUnsavedChanges = savedOnServer
    ? isProposalDirty(savedOnServer, proposal)
    : isProposalDirty(initialProposal, proposal);
  const pdfSource = !hasUnsavedChanges && savedOnServer ? savedOnServer : null;
  const awaitingServerCopy = !savedOnServer && allowEditorAction('save');

  // Sync from parent only when it is not overwriting unsaved local edits (гонка PUT/bootstrap).
  useEffect(() => {
    setProposal(prev => {
      const parentStamp = proposalWriteStamp(initialProposal);
      const localStamp = proposalWriteStamp(prev);
      if (parentStamp === localStamp) return prev;
      if (persistedProposal && proposalWriteStamp(persistedProposal) !== localStamp) {
        return prev;
      }
      return initialProposal;
    });
  }, [initialProposal, persistedProposal]);

  const directorViewOnly = currentUser.role === 'FULL_ACCESS'
    && (initialProposal.status === 'ready' || initialProposal.status === 'sent');
  const directorDocument = directorViewOnly
    ? readDirectorDocument(initialProposal, currentUser.role)
    : null;
  const documentView = directorProposalView(proposal, currentUser.role);
  const releasedSurface = directorTemplateSurface(initialProposal, currentUser.role);
  const deliveryShown = releasedSurface ? releasedSurface.deliveryMethod : proposal.deliveryMethod;
  const releasedView = documentForReading(proposal);
  const viewed = directorDocument
    ? viewProjection(directorDocument)
    : releasedView
      ? viewProjection(releasedView)
      : null;
  const refuseDirectorEdit = (edit: (current: CommercialProposal) => CommercialProposal) => {
    if (foreignLocked) return true;
    if (!directorViewOnly) return false;
    const next = applyDirectorViewEdit(proposal, edit);
    if (next !== proposal) {
      setProposal(next);
      onSave(next);
    }
    return true;
  };

  const robatechItems = documentView.items.filter(
    i => i.source === 'robatech_price' || i.catalogBrand === 'robatech'
  );
  const klerotechItems = documentView.items.filter(
    i => i.source === 'klerotech_price' || i.catalogBrand === 'klerotech'
  );
  const isMixedBrands = robatechItems.length > 0 && klerotechItems.length > 0;
  const sumRobatech = robatechItems.reduce(
    (sum, i) =>
      sum +
      lineBaseAmount(i.priceBasis, i.unitPrice, i.quantity) *
        (1 - (i.discountPercent || 0) / 100),
    0
  );
  const sumKlerotech = klerotechItems.reduce(
    (sum, i) =>
      sum +
      lineBaseAmount(i.priceBasis, i.unitPrice, i.quantity) *
        (1 - (i.discountPercent || 0) / 100),
    0
  );

  // Helper to create a version snapshot
  const createSnapshot = (current: CommercialProposal, reason: string): ProposalVersionSnapshot => {
    const currentTotals = calculateProposalTotals(current);
    return {
      id: 'snap-' + Date.now(),
      version: current.version,
      timestamp: new Date().toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      authorId: currentUser.id,
      authorName: currentUser.name,
      status: current.status,
      summary: reason,
      totalAmount: currentTotals.grandTotal,
      itemsCount: current.items.length,
      snapshotData: JSON.parse(JSON.stringify(current))
    };
  };

  const handleApplyReconciliation = (updatedItems: ProposalItem[], createNewVer: boolean) => {
    if (refuseDirectorEdit(current => ({ ...current, items: updatedItems }))) return;
    if (!allowEditorAction('reconcile')) return;
    if (createNewVer) {
      const nextVer = proposal.version + 1;
      const snapshot = createSnapshot(proposal, `Сверка с прайсом перед v${nextVer}`);
      const updated: CommercialProposal = appendProposalAudit({
        ...proposal,
        version: nextVer,
        items: updatedItems,
        updatedAt: new Date().toISOString(),
        versions: [snapshot, ...(proposal.versions || [])]
      }, {
        type: 'version_created',
        at: new Date().toISOString(),
        userId: currentUser.id,
        userName: currentUser.name,
        action: `Сверка с утвержденным прайсом: создана ревизия v${nextVer} с актуализированными ценами`,
        version: nextVer
      });
      setProposal(updated);
      onSave(updated);
    } else {
      updateProposal({ items: updatedItems, auditLog: appendProposalAudit(
        { ...proposal, items: updatedItems },
        {
          type: 'line_changed',
          at: new Date().toISOString(),
          userId: currentUser.id,
          userName: currentUser.name,
          action: 'Изменена строка'
        }
      ).auditLog });
    }
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 2500);
  };

  // Auto-save within the same draft without creating duplicate records
  const updateProposal = (partial: Partial<CommercialProposal>) => {
    if (refuseDirectorEdit(current => ({ ...current, ...partial }))) return;
    if (!allowEditorAction('save')) return;
    const updated = normalizeProposalForPersist({
      ...proposal,
      ...partial,
      updatedAt: new Date().toISOString()
    });
    setProposal(updated);
    onSave(updated); // auto-saves in-place
  };

  const commitAudit = (partial: Partial<CommercialProposal>, type: ProposalAuditType, action: string) => {
    const audited = appendProposalAudit({ ...proposal, ...partial }, {
      type,
      at: new Date().toISOString(),
      userId: currentUser.id,
      userName: currentUser.name,
      action
    });
    updateProposal({ ...partial, auditLog: audited.auditLog });
  };

  // Manual save with version snapshot recording
  const handleManualSave = () => {
    if (refuseDirectorEdit(current => ({ ...current, updatedAt: new Date().toISOString() }))) return;
    if (!allowEditorAction('save')) return;
    const snapshot = createSnapshot(proposal, `Сохранение изменений (v${proposal.version})`);
    const updated = normalizeProposalForPersist({
      ...proposal,
      versions: [snapshot, ...(proposal.versions || [])],
      updatedAt: new Date().toISOString()
    });
    setProposal(updated);
    onSave(updated);
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 2500);
  };

  // Restore previous historical version
  const handleRestoreVersion = (snapshot: ProposalVersionSnapshot) => {
    if (refuseDirectorEdit(current => ({ ...current, version: current.version + 1 }))) return;
    if (!allowEditorAction('restore')) return;
    const restoredData = snapshot.snapshotData;
    const currentSnapshotBeforeRestore = createSnapshot(proposal, `Перед откатом к v${snapshot.version}`);
    
    const updated: CommercialProposal = {
      ...restoredData,
      id: proposal.id, // keep active proposal ID
      number: proposal.number,
      version: proposal.version + 1, // increment version number on restore
      updatedAt: new Date().toISOString(),
      versions: [currentSnapshotBeforeRestore, ...(proposal.versions || [])],
      auditLog: [
        ...(proposal.auditLog || []),
        {
          id: 'log-' + Date.now(),
          timestamp: new Date().toLocaleString('ru-RU'),
          userId: currentUser.id,
          userName: currentUser.name,
          action: `Восстановлено состояние из ревизии v${snapshot.version} от ${snapshot.timestamp}`
        }
      ]
    };

    setProposal(updated);
    onSave(updated);
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 2500);
  };

  // When client is selected from CRM
  const handleClientSelect = (client: ClientInfo) => {
    if (!allowEditorAction('editClient')) return;
    const snapshot = proposalClientFromCrm(client);
    const nextClient = {
      ...snapshot,
      assignedManagerId: snapshot.assignedManagerId || currentUser.id,
      assignedManagerName: snapshot.assignedManagerName || currentUser.name
    };
    if (nextClient.companyName === documentView.client.companyName && nextClient.id === documentView.client.id && nextClient.contactPerson === documentView.client.contactPerson) {
      updateProposal({ client: nextClient });
      return;
    }
    commitAudit({ client: nextClient }, 'client_changed', 'Изменён клиент КП');
  };

  // Add Item
  const handleAddItem = (preset?: Partial<ProposalItem>) => {
    if (!allowEditorAction('editItems')) return;
    const managerManualReason = '';
    const newItem: ProposalItem = {
      id: 'item-' + Date.now() + Math.random().toString(36).substring(2, 5),
      article: preset?.article || '',
      title: preset?.title || '',
      description: preset?.description || '',
      unit: preset?.unit || 'шт.',
      priceBasis: preset?.priceBasis || 'unit',
      quantity: preset?.quantity || 1,
      unitPrice: preset?.unitPrice ?? 0,
      discountPercent: preset?.discountPercent ?? 0,
      catalogOriginalPrice: preset?.catalogOriginalPrice ?? (preset?.unitPrice ? preset.unitPrice : undefined),
      catalogBrand: preset?.catalogBrand,
      isPriceModified: preset?.isPriceModified || false,
      source: preset?.source ?? sourceForNewLine(),
      priceSource: preset?.priceSource ?? linePriceSourceOf(preset?.source ?? sourceForNewLine()),
      priceReason: preset?.priceReason ?? preset?.priceSourceReason ?? (managerWizard ? '' : ''),
      priceSourceDetail: preset?.priceSourceDetail ?? preset?.priceSourceDetails ?? (managerWizard ? '' : ''),
      priceSourceReason: preset?.priceSourceReason ?? preset?.priceReason ?? (managerWizard ? '' : ''),
      priceSourceDetails: preset?.priceSourceDetails ?? preset?.priceSourceDetail ?? (managerWizard ? '' : ''),
      priceListVersion: preset?.priceListVersion,
    };
    const priced = finalizeLinePriceOrigin(newItem);

    const newItems = [...documentView.items, priced];
    commitAudit({ items: newItems }, 'line_added', 'Добавлена строка');
  };

  // Remove Item
  const handleRemoveItem = (itemId: string) => {
    if (!allowEditorAction('editItems')) return;
    const next = proposal.status === 'draft'
      ? removeDraftProposalLine(proposal, itemId)
      : { items: removeLineById(documentView.items, itemId) };
    if (next.items === documentView.items) return;
    commitAudit({ items: next.items }, 'line_removed', 'Удалена строка');
  };

  const applyManualLineHintOnTitleBlur = (itemId: string, title: string) => {
    const hint = matchManualLineHint(manualLineHints, title);
    if (!hint) return;
    const item = documentView.items.find(i => i.id === itemId);
    if (!item || linePriceSourceOf(item.priceSource ?? item.source) !== 'manual') return;
    if (item.catalogOriginalPrice !== undefined) return;
    const patched = documentView.items.map(i =>
      i.id === itemId
        ? {
            ...i,
            title: hint.title,
            unit: hint.unit || i.unit,
            unitPrice: hint.unitPrice > 0 ? hint.unitPrice : i.unitPrice,
            priceSourceReason: i.priceSourceReason || '',
            priceReason: i.priceReason || '',
            priceSourceDetail: i.priceSourceDetail || '',
            priceSourceDetails: i.priceSourceDetails || ''
          }
        : i
    );
    if (JSON.stringify(patched) === JSON.stringify(documentView.items)) return;
    commitAudit({ items: patched }, 'line_changed', 'Подставлена подсказка по ручной строке');
  };

  // Update Item with price change detection and brand lock
  const handleUpdateItem = (itemId: string, field: keyof ProposalItem, value: any) => {
    if (!allowEditorAction(field === 'unitPrice' ? 'editPrices' : field === 'discountPercent' ? 'editDiscounts' : 'editItems')) return;
    const newItems = documentView.items.map(item => {
      if (item.id === itemId) {
        if (field === 'quantity' || field === 'unitPrice' || field === 'priceBasis') {
          const edited = applyLineAmountEdit(item, {
            quantity: field === 'quantity' ? Number(value) : undefined,
            unitPrice: field === 'unitPrice' ? Number(value) : undefined,
            priceBasis: field === 'priceBasis' ? value as PriceBasis : undefined
          });
          if (field === 'unitPrice') {
            const numPrice = edited.unitPrice;
            let isPriceModified = item.isPriceModified;
            if (item.catalogOriginalPrice !== undefined) {
              isPriceModified = Math.abs(numPrice - item.catalogOriginalPrice) > 0.001;
            }
            return { ...edited, isPriceModified };
          }
          return edited;
        }

        if (field === 'source') {
          return applyExplicitLineSource(item, value as PriceSource);
        }

        if (field === 'priceSourceReason' || field === 'priceReason') {
          return finalizeLinePriceOrigin({
            ...item,
            priceReason: String(value ?? ''),
            priceSourceReason: String(value ?? '')
          });
        }

        if (field === 'priceSourceDetails' || field === 'priceSourceDetail') {
          return finalizeLinePriceOrigin({
            ...item,
            priceSourceDetail: String(value ?? ''),
            priceSourceDetails: String(value ?? '')
          });
        }

        return { ...item, [field]: value };
      }
      return item;
    });
    if (JSON.stringify(newItems) === JSON.stringify(documentView.items)) return;
    commitAudit({ items: newItems }, 'line_changed', 'Изменена строка');
  };

  // Reset item price back to official catalog price
  const handleResetItemPrice = (itemId: string) => {
    if (!allowEditorAction('editPrices')) return;
    const newItems = documentView.items.map(item => {
      if (item.id === itemId && item.catalogOriginalPrice !== undefined) {
        return applyLineAmountEdit(
          { ...item, isPriceModified: false },
          { unitPrice: item.catalogOriginalPrice }
        );
      }
      return item;
    });
    if (JSON.stringify(newItems) === JSON.stringify(documentView.items)) return;
    commitAudit({ items: newItems }, 'line_changed', 'Изменена строка');
  };

  // Add Engineer Work
  const handleAddEngineerWork = () => {
    if (!allowEditorAction('editEngineerWorks')) return;
    const newWork: EngineerWorkItem = {
      id: 'eng-' + Date.now(),
      title: 'Шеф-монтаж и пусконаладочные работы оборудования',
      description: 'Выезд сертифицированного инженера, подключение, регулировка параметров нанесения клея',
      unit: 'компл.',
      quantity: 1,
      unitPrice: 500,
      discountPercent: 0
    };
    updateProposal({
      engineerWorks: [...(documentView.engineerWorks || []), newWork]
    });
  };

  const handleUpdateEngineerWork = (workId: string, field: keyof EngineerWorkItem, value: any) => {
    if (!allowEditorAction('editEngineerWorks')) return;
    const newWorks = (documentView.engineerWorks || []).map(w => {
      if (w.id === workId) {
        return { ...w, [field]: value };
      }
      return w;
    });
    updateProposal({ engineerWorks: newWorks });
  };

  const handleRemoveEngineerWork = (workId: string) => {
    if (!allowEditorAction('editEngineerWorks')) return;
    const newWorks = (documentView.engineerWorks || []).filter(w => w.id !== workId);
    updateProposal({ engineerWorks: newWorks });
  };

  const canDelete = canActorDeleteProposal(currentUser, initialProposal);
  const totals = calculateProposalTotals(documentView);
  const showWizardClient = !managerWizard || wizardStep === 1;
  const showWizardItems = !managerWizard || wizardStep === 2;
  const showWizardReview = managerWizard && wizardStep === 3;
  const showLegacySettings = !managerWizard;

  return (
    <div className="space-y-6">
      {/* Top Action Bar */}
      <div className="bg-white border-2 border-black rounded-2xl p-4 shadow-[4px_4px_0px_#000] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-xl border-2 border-black bg-stone-100 hover:bg-stone-200 transition flex items-center gap-1.5 px-3"
            title="Назад к списку КП"
          >
            <ArrowLeft className="w-5 h-5 text-black" />
            {managerWizard && <span className="text-xs font-black">К списку</span>}
          </button>
          {!managerWizard && (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-black text-lg text-slate-900">
                {documentView.number}
              </span>
              <button
                onClick={() => setIsVersionHistoryOpen(true)}
                className="text-xs px-2.5 py-0.5 font-bold rounded-md bg-stone-100 hover:bg-amber-200 border border-black flex items-center gap-1 transition"
                title="Открыть историю версий и точек отката"
              >
                <History className="w-3.5 h-3.5 text-slate-700" />
                <span>v{documentView.version}</span>
                {(proposal.versions?.length || 0) > 0 && (
                  <span className="text-[10px] bg-black text-amber-300 px-1 rounded font-mono">
                    {proposal.versions?.length}
                  </span>
                )}
              </button>
              <span className={`text-xs px-2.5 py-0.5 font-black uppercase rounded-md border ${
                proposal.status === 'draft' ? 'bg-amber-100 text-amber-900 border-amber-300' :
                proposal.status === 'ready' ? 'bg-sky-100 text-sky-900 border-sky-300' :
                'bg-emerald-100 text-emerald-900 border-emerald-300'
              }`}>
                {proposal.status === 'draft' ? 'Черновик' : proposal.status === 'ready' ? 'PDF готов' : 'Отправлено клиенту'}
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-0.5">
              Автор: <span className="font-bold text-slate-800">{documentView.authorName}</span> ({documentView.authorRegion})
              {documentView.client.companyName && ` · Заказчик: ${documentView.client.companyName}`}
            </p>
          </div>
          )}
          {managerWizard && (
            <p className="text-sm font-black text-slate-900">
              {documentView.number}
              {documentView.client.companyName ? ` · ${documentView.client.companyName}` : ''}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {allowEditorAction('save') && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleManualSave}
                className="px-3 py-2 bg-amber-400 hover:bg-amber-300 text-black font-black text-xs rounded-xl border-2 border-black shadow-[2px_2px_0px_#000] flex items-center gap-1.5 transition active:translate-y-0.5"
              >
                <Save className="w-4 h-4" />
                Сохранить
              </button>
              <span className={`text-xs font-bold ${hasUnsavedChanges ? 'text-rose-700' : 'text-emerald-800'}`}>
                {hasUnsavedChanges
                  ? 'Есть несохранённые изменения'
                  : saveSuccessNotice
                    ? 'Сохранено'
                    : ''}
              </span>
            </div>
          )}

          {(!managerWizard || wizardStep === 3) && (
          <>
          <button
            type="button"
            disabled={!pdfSource}
            title={
              awaitingServerCopy
                ? 'Подождите, КП сохраняется на сервер'
                : hasUnsavedChanges
                  ? 'Сначала сохраните изменения'
                  : 'Предпросмотр PDF'
            }
            onClick={() => {
              if (!pdfSource) return;
              if (onPreviewPdf) onPreviewPdf(pdfSource);
              else onOpenPdf(pdfSource);
            }}
            className="px-3.5 py-2 font-black text-xs rounded-xl border-2 border-black shadow-[2px_2px_0px_#000] flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed bg-sky-300 hover:bg-sky-200 text-slate-950"
          >
            <Eye className="w-4 h-4" />
            Предпросмотр PDF
          </button>

          <button
            type="button"
            disabled={!pdfSource}
            title={
              awaitingServerCopy
                ? 'Подождите, КП сохраняется на сервер'
                : hasUnsavedChanges
                  ? 'Сначала сохраните изменения'
                  : 'Скачать PDF'
            }
            onClick={() => {
              if (!pdfSource) return;
              if (onDownloadPdf) void onDownloadPdf(pdfSource);
            }}
            className="px-3.5 py-2 font-black text-xs rounded-xl border-2 border-black shadow-[2px_2px_0px_#000] flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed bg-amber-400 hover:bg-amber-300 text-black"
          >
            <FileDown className="w-4 h-4" />
            Скачать PDF
          </button>
          </>
          )}

          {!managerWizard && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setHeaderMenuOpen(open => !open)}
              className="p-2 rounded-xl border-2 border-black bg-stone-100 hover:bg-stone-200"
              title="Дополнительные действия"
              aria-expanded={headerMenuOpen}
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>
            {headerMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[220px] bg-white border-2 border-black rounded-xl shadow-[4px_4px_0px_#000] py-1 text-xs font-bold">
                {initialProposal.status !== 'sent' && allowEditorAction('markSent') && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-amber-100"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      onMarkAsSent(initialProposal.id);
                    }}
                  >
                    Отметить «Отправлено»
                  </button>
                )}
                {canDelete && allowEditorAction('delete') && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-rose-100 text-rose-900"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      if (window.confirm(`Удалить ${proposal.number}?`)) onDelete(initialProposal.id);
                    }}
                  >
                    Удалить
                  </button>
                )}
                {allowEditorAction('editTemplate') && (
                  <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); setIsTemplateModalOpen(true); }}>Шаблон КП</button>
                )}
                {allowEditorAction('reconcile') && (
                  <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); setIsReconciliationOpen(true); }}>Сверка с прайсом</button>
                )}
                <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); setIsVersionHistoryOpen(true); }}>Версии</button>
                <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); exportProposalToExcel(proposal); }}>{INTERNAL_EXCEL_LABEL}</button>
                <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); onOpenEmailText(proposal); }}>Письмо</button>
                {initialProposal.status === 'draft' && allowEditorAction('release') && (
                  <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); onReleasePdf(proposal); }}>Выпустить PDF (служебно)</button>
                )}
                {initialProposal.status !== 'draft' && allowEditorAction('newVersion') && (
                  <button type="button" className="w-full text-left px-3 py-2 hover:bg-stone-100" onClick={() => { setHeaderMenuOpen(false); onCreateNewVersion(initialProposal); }}>Новая версия</button>
                )}
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {managerWizard && (
        <div className="bg-white border-2 border-black rounded-2xl p-4 shadow-[4px_4px_0px_#000] flex flex-col sm:flex-row gap-3">
          {([
            [1, 'Клиент'],
            [2, 'Позиции'],
            [3, 'Проверка и PDF']
          ] as const).map(([step, label]) => (
            <button
              key={step}
              type="button"
              onClick={() => setWizardStep(step)}
              className={`flex-1 min-w-0 px-4 py-3.5 rounded-xl border-2 border-black text-sm sm:text-base font-black transition ${
                wizardStep === step
                  ? 'bg-amber-400 shadow-[3px_3px_0px_#000]'
                  : 'bg-stone-100 hover:bg-stone-200'
              }`}
            >
              {step}. {label}
            </button>
          ))}
        </div>
      )}

      {managerWizard && wizardStep === 1 && (
        <KpWizardClientStep
          client={documentView.client}
          clientScopeAll={kpClientScopeAll}
          canEdit={allowEditorAction('editClient')}
          onPickFromDb={() => {
            setCrmModalMode('list');
            setIsCrmModalOpen(true);
          }}
          onAddNew={() => {
            setCrmModalMode('create');
            setIsCrmModalOpen(true);
          }}
          onContactChange={val => {
            const capitalized = val.replace(/(^|\s|-)([а-яa-zё])/gi, m => m.toUpperCase());
            if (capitalized === documentView.client.contactPerson) return;
            commitAudit(
              { client: { ...documentView.client, contactPerson: capitalized } },
              'client_changed',
              'Обновлён контакт для КП'
            );
          }}
          onPhoneChange={phone => {
            updateProposal({ client: { ...documentView.client, phone } });
          }}
          onNext={() => setWizardStep(2)}
        />
      )}

      {showWizardReview && (
        <KpWizardReviewStep
          proposal={proposal}
          client={documentView.client}
          items={documentView.items}
          engineerWorks={documentView.engineerWorks || []}
          grandTotal={totals.grandTotal}
          hasUnsavedChanges={hasUnsavedChanges}
          awaitingServerCopy={awaitingServerCopy}
          pdfReady={Boolean(pdfSource)}
          onSave={handleManualSave}
          onPreviewPdf={() => {
            if (!pdfSource) return;
            if (onPreviewPdf) onPreviewPdf(pdfSource);
            else onOpenPdf(pdfSource);
          }}
          onDownloadPdf={() => {
            if (!pdfSource) return;
            if (onDownloadPdf) void onDownloadPdf(pdfSource);
          }}
          onOpenEmail={() => onOpenEmailText(proposal)}
          onOpenAdvantages={() => setIsTemplateModalOpen(true)}
          canMarkSent={initialProposal.status !== 'sent' && allowEditorAction('markSent')}
          onMarkSent={() => onMarkAsSent(initialProposal.id)}
          onGreetingChange={pdfGreeting => {
            updateProposal({ client: { ...documentView.client, pdfGreeting } });
          }}
        />
      )}

      {/* Main Grid: Settings & Items */}
      {foreignLocked && (
        <p className="text-sm font-semibold text-stone-700">Чужое КП открыто только для просмотра.</p>
      )}
      {(!managerWizard || wizardStep === 2) && (
      <fieldset disabled={sentLocked} className={`grid grid-cols-1 lg:grid-cols-3 gap-6 border-0 p-0 m-0 min-w-0 ${sentLocked ? '[&_button]:opacity-40 [&_button]:cursor-not-allowed' : ''}`}>
        {/* Left Column: Metadata, Client, Blank & Delivery Settings */}
        <div className={`space-y-6 ${managerWizard ? 'hidden' : ''}`}>
          {/* Section 1: Client Card — только legacy; мастер: KpWizardClientStep */}
          {!managerWizard && showWizardClient && (
          <div className="bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            <div className="flex items-center justify-between border-b-2 border-black pb-2">
              <h3 className="font-black text-sm uppercase tracking-wide text-slate-900 flex items-center gap-1.5">
                <Building2 className="w-4 h-4 text-emerald-600" />
                1. Клиент и реквизиты CRM
              </h3>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    if (!allowEditorAction('editClient')) return;
                    setCrmModalMode('create');
                    setIsCrmModalOpen(true);
                  }}
                  className="text-xs font-black text-black bg-emerald-400 hover:bg-emerald-300 px-2.5 py-1 rounded-lg border border-black shadow-[1px_1px_0px_#000] flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  + Новый в CRM
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!allowEditorAction('editClient')) return;
                    setCrmModalMode('list');
                    setIsCrmModalOpen(true);
                  }}
                  className="text-xs font-black text-black bg-amber-400 hover:bg-amber-300 px-2.5 py-1 rounded-lg border border-black shadow-[1px_1px_0px_#000]"
                >
                  База CRM
                </button>
              </div>
            </div>
            {/* Quick choose from CRM dropdown */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Выбрать контрагента из CRM:
              </label>
              <select
                value={documentView.client.crmId || ''}
                onChange={e => {
                  const found = clients.find(c => (c.crmId || c.companyName) === e.target.value);
                  if (found) handleClientSelect(found);
                }}
                className="w-full text-xs p-2.5 bg-slate-50 border-2 border-black rounded-xl font-bold focus:outline-none"
              >
                <option value="">— Выберите из базы CRM ({clients.length} клиентов) —</option>
                {clients.map(c => (
                  <option key={c.id || c.crmId || c.companyName} value={c.crmId || c.companyName}>
                    {c.companyName}{c.contactPerson ? ` · ${c.contactPerson}` : ''}{c.requisites?.inn ? ` · ИНН ${c.requisites.inn}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Manual / Synced company name */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Наименование компании:
              </label>
              <input
                type="text"
                data-kp-field="companyName"
                placeholder="Например: АО «Упаковочные Системы»"
                value={documentView.client.companyName}
                onChange={e => {
                  const val = e.target.value;
                  // Auto-capitalize first letter
                  const formatted = val ? (val.charAt(0).toUpperCase() + val.slice(1)) : '';
                  if (formatted === documentView.client.companyName) return;
                  commitAudit({ client: clientAfterCompanyRename(documentView.client, formatted) }, 'client_changed', 'Изменён клиент КП');
                }}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl font-bold focus:outline-none"
              />
              <span className="text-[10px] text-slate-400 block mt-0.5">
                Первая буква автоматически поднимается в заглавную
              </span>
            </div>

            {/* Contact person */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Контактное лицо (ФИО):
              </label>
              <input
                type="text"
                data-kp-field="contactPerson"
                placeholder="Например: ФИО контактного лица"
                value={documentView.client.contactPerson}
                onChange={e => {
                  const val = e.target.value;
                  // Auto-capitalize each word on typing
                  const capitalized = val.replace(/(^|\s|-)([а-яa-zё])/gi, (m) => m.toUpperCase());
                  if (capitalized === documentView.client.contactPerson) return;
                  commitAudit({ client: { ...documentView.client, contactPerson: capitalized } }, 'client_changed', 'Изменён клиент КП');
                }}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl font-medium focus:outline-none"
              />
              {/[0-9]/.test(documentView.client.contactPerson) ? (
                <span className="text-[10px] text-amber-700 font-semibold block mt-0.5">
                  В ФИО обычно указываются только буквы
                </span>
              ) : (
                <span className="text-[10px] text-slate-400 block mt-0.5">
                  Каждое слово автоматически поднимается в заглавную букву
                </span>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Обращение в PDF:</label>
              <select
                value={
                  ['Уважаемый ', 'Уважаемая ', 'Уважаемые коллеги!', 'Без обращения'].includes(
                    documentView.client.pdfGreeting || ''
                  )
                    ? documentView.client.pdfGreeting || ''
                    : '__custom__'
                }
                onChange={e => {
                  const v = e.target.value;
                  if (v === '__custom__') return;
                  const contact = documentView.client.contactPerson.trim();
                  let pdfGreeting = v;
                  if (v === 'Уважаемый ' && contact) pdfGreeting = `Уважаемый ${contact}!`;
                  if (v === 'Уважаемая ' && contact) pdfGreeting = `Уважаемая ${contact}!`;
                  updateProposal({ client: { ...documentView.client, pdfGreeting } });
                }}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl font-medium"
              >
                <option value="Уважаемый ">Уважаемый …</option>
                <option value="Уважаемая ">Уважаемая …</option>
                <option value="Уважаемые коллеги!">Уважаемые коллеги!</option>
                <option value="Без обращения">Без обращения</option>
                <option value="__custom__">Свой текст (поле ниже)</option>
              </select>
              <input
                type="text"
                className="w-full text-xs p-2.5 mt-2 bg-white border-2 border-black rounded-xl font-medium"
                placeholder="Свой вариант обращения для PDF"
                value={documentView.client.pdfGreeting || ''}
                onChange={e => updateProposal({ client: { ...documentView.client, pdfGreeting: e.target.value } })}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Телефон:</label>
                <input
                  type="text"
                  placeholder="+7 (___) ___-__-__"
                  value={documentView.client.phone || ''}
                  onChange={e => {
                    const raw = e.target.value;
                    const filtered = raw.replace(/[^0-9+() -]/g, '');
                    updateProposal({ client: { ...documentView.client, phone: filtered } });
                  }}
                  className="w-full text-xs p-2 bg-white border-2 border-black rounded-xl font-mono focus:outline-none"
                />
                <span className="text-[10px] text-slate-400 block mt-0.5 truncate">
                  Только цифры и + () -
                </span>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Email:</label>
                <input
                  type="email"
                  placeholder="client@mail.ru"
                  value={documentView.client.email || ''}
                  onChange={e => updateProposal({ client: { ...documentView.client, email: e.target.value.trim() } })}
                  className={`w-full text-xs p-2 bg-white border-2 rounded-xl font-mono focus:outline-none ${
                    documentView.client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(documentView.client.email)
                      ? 'border-amber-500 bg-amber-50/30'
                      : 'border-black'
                  }`}
                />
                {documentView.client.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(documentView.client.email) ? (
                  <span className="text-[10px] text-emerald-700 font-bold block mt-0.5">
                    Формат корректен
                  </span>
                ) : documentView.client.email ? (
                  <span className="text-[10px] text-amber-700 font-bold block mt-0.5">
                    Пример: name@company.ru
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400 block mt-0.5">
                    Email для отправки КП
                  </span>
                )}
              </div>
            </div>

            {/* Connected CRM Legal Requisites Badge */}
            {documentView.client.requisites ? (
              <div className="bg-emerald-50 border-2 border-emerald-300 rounded-xl p-3 space-y-1.5 text-xs text-emerald-950">
                <div className="flex items-center justify-between font-black">
                  <span className="flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-emerald-700" />
                    Реквизиты CRM подключены
                  </span>
                  <button
                    type="button"
                    onClick={() => { if (allowEditorAction('editClient')) setIsCrmModalOpen(true); }}
                    className="text-[11px] text-emerald-700 hover:underline font-bold"
                  >
                    Изменить
                  </button>
                </div>
                <div className="font-mono text-[11px] text-slate-700">
                  ИНН: <span className="font-bold">{documentView.client.requisites.inn}</span>
                  {documentView.client.requisites.kpp && ` / КПП: ${documentView.client.requisites.kpp}`}
                </div>
                {documentView.client.requisites.legalAddress && (
                  <div className="text-[11px] text-slate-600 truncate" title={documentView.client.requisites.legalAddress}>
                    Адрес: {documentView.client.requisites.legalAddress}
                  </div>
                )}
                {documentView.client.requisites.bankName && (
                  <div className="text-[11px] text-slate-500 truncate" title={documentView.client.requisites.bankName}>
                    Банк: {documentView.client.requisites.bankName}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-stone-50 border border-stone-300 rounded-xl p-3 text-xs text-slate-600 flex items-center justify-between">
                <span>Реквизиты не подтянуты</span>
                <button
                  type="button"
                  onClick={() => { if (allowEditorAction('editClient')) setIsCrmModalOpen(true); }}
                  className="font-bold text-amber-700 hover:underline"
                >
                  Выбрать из CRM
                </button>
              </div>
            )}
          </div>
          )}

          {/* Section 2: Blank Type & Template Section Config */}
          {showLegacySettings && (
          <>
          <div className="bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            <div className="flex items-center justify-between border-b-2 border-black pb-2">
              <h3 className="font-black text-sm uppercase tracking-wide text-slate-900">
                2. Фирменный бланк и разделы
              </h3>
              <button
                type="button"
                onClick={() => { if (allowEditorAction('editTemplate')) setIsTemplateModalOpen(true); }}
                className="text-xs font-bold text-purple-800 hover:underline flex items-center gap-1"
              >
                <Sliders className="w-3.5 h-3.5" />
                Настроить разделы
              </button>
            </div>

            {/* Blank selection */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Выбор утвержденного бланка:
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => updateProposal({ blankType: 'klerotech', currency: 'EUR', vatRate: 20 })}
                  className={`p-3 rounded-xl border-2 border-black text-left font-bold text-xs transition ${
                    documentView.blankType === 'klerotech'
                      ? 'bg-amber-300 shadow-[3px_3px_0px_#000] text-black'
                      : 'bg-white hover:bg-stone-50 text-slate-600'
                  }`}
                >
                  <div className="font-extrabold text-sm">Клеротех</div>
                  <div className="text-[10px] opacity-80 mt-0.5">Колонка EU (EUR с НДС)</div>
                </button>

                <button
                  type="button"
                  onClick={() => updateProposal({
                    blankType: 'robatech',
                    currency: proposal.currency === 'CHF' ? 'CHF' : 'EUR',
                    vatRate: 22
                  })}
                  className={`p-3 rounded-xl border-2 border-black text-left font-bold text-xs transition ${
                    documentView.blankType === 'robatech'
                      ? 'bg-emerald-300 shadow-[3px_3px_0px_#000] text-black'
                      : 'bg-white hover:bg-stone-50 text-slate-600'
                  }`}
                >
                  <div className="font-extrabold text-sm">Robatech</div>
                  <div className="text-[10px] opacity-80 mt-0.5">НДС 22%, валюта EUR или CHF</div>
                </button>
              </div>
              {documentView.blankType === 'robatech' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(['EUR', 'CHF'] as const).map(currency => (
                    <button
                      key={currency}
                      type="button"
                      onClick={() => updateProposal({ currency })}
                      className={`px-3 py-2 rounded-xl border-2 border-black text-xs font-bold ${
                        proposal.currency === currency ? 'bg-emerald-200 text-black' : 'bg-white text-slate-600'
                      }`}
                    >
                      {currency}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Template Status Overview */}
            <div className="bg-purple-50 border-2 border-purple-200 rounded-xl p-3 text-xs text-purple-950 space-y-1.5">
              <div className="font-bold flex items-center justify-between">
                <span>Пресет шаблона: {releasedSurface ? releasedSurface.presetLabel : (proposal.templateConfig?.presetName || 'Стандартный')}</span>
                <span className="text-[10px] bg-purple-200 text-purple-900 px-1.5 py-0.5 rounded font-mono">
                  {releasedSurface ? releasedSurface.advantagesCountLabel : (proposal.templateConfig?.advantagesList?.length || 4)} преимуществ
                </span>
              </div>
              <div className="text-[11px] text-slate-600 flex flex-wrap gap-2">
                <span>Реквизиты: {releasedSurface ? releasedSurface.requisitesLabel : (proposal.templateConfig?.showClientRequisites ? 'Да' : 'Нет')}</span>
                <span>·</span>
                <span>Преимущества: {releasedSurface ? releasedSurface.advantagesFlagLabel : (proposal.templateConfig?.showAdvantages ? 'Да' : 'Нет')}</span>
                <span>·</span>
                <span>Доп. условия: {releasedSurface ? releasedSurface.additionalLabel : (proposal.templateConfig?.showAdditionalConditions ? 'Да' : 'Нет')}</span>
              </div>
            </div>

            {/* Customer PDF Display Toggle */}
            <div className="p-3 bg-amber-50 border-2 border-amber-300 rounded-xl">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={documentView.showPositionPricesInPdf}
                  onChange={e => updateProposal({ showPositionPricesInPdf: e.target.checked })}
                  className="w-4 h-4 rounded text-amber-500 focus:ring-amber-400"
                />
                <div>
                  <span className="text-xs font-black text-slate-900 block">
                    Цены по строкам
                  </span>
                  <span className="text-[10px] text-slate-600 block">
                    Если снять галочку, столбцы цены и суммы в бланке и в Excel пропадают
                  </span>
                </div>
              </label>
              <label className="flex items-center gap-2.5 cursor-pointer mt-3">
                <input
                  type="checkbox"
                  checked={documentView.showArticleInPdf !== false}
                  onChange={e => updateProposal({ showArticleInPdf: e.target.checked })}
                  className="w-4 h-4 rounded text-amber-500 focus:ring-amber-400"
                />
                <div>
                  <span className="text-xs font-black text-slate-900 block">Артикул</span>
                  <span className="text-[10px] text-slate-600 block">Снимите галочку, если артикул клиенту показывать не нужно</span>
                </div>
              </label>
            </div>
          </div>

          {/* Section 3: Delivery, Validity & Conditions */}
          <div className="bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            <div className="flex items-center justify-between border-b-2 border-black pb-2">
              <h3 className="font-black text-sm uppercase tracking-wide text-slate-900">
                3. Условия и логистика
              </h3>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Способ получения:{releasedSurface && !deliveryShown ? ' нет в снимке' : ''}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={Boolean(releasedSurface)}
                  onClick={releasedSurface ? undefined : () => updateProposal({ deliveryMethod: 'Склад СПб' })}
                  className={`p-2.5 rounded-xl border-2 border-black font-bold text-xs transition ${
                    deliveryShown === 'Склад СПб'
                      ? 'bg-amber-300 shadow-[2px_2px_0px_#000] text-black'
                      : releasedSurface
                        ? 'bg-white text-slate-600'
                        : 'bg-white hover:bg-stone-50 text-slate-600'
                  }`}
                >
                  Склад СПб
                </button>
                <button
                  type="button"
                  disabled={Boolean(releasedSurface)}
                  onClick={releasedSurface ? undefined : () => updateProposal({ deliveryMethod: 'Доставка' })}
                  className={`p-2.5 rounded-xl border-2 border-black font-bold text-xs transition ${
                    deliveryShown === 'Доставка'
                      ? 'bg-amber-300 shadow-[2px_2px_0px_#000] text-black'
                      : releasedSurface
                        ? 'bg-white text-slate-600'
                        : 'bg-white hover:bg-stone-50 text-slate-600'
                  }`}
                >
                  Доставка
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Срок действия КП:
              </label>
              <input
                type="date"
                value={documentView.validityDate}
                onChange={e => updateProposal({ validityDate: e.target.value })}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl font-bold font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Условия оплаты:</label>
              <input
                type="text"
                value={documentView.paymentTerms}
                onChange={e => updateProposal({ paymentTerms: e.target.value })}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Сроки поставки:</label>
              <input
                type="text"
                value={documentView.deliveryTerms}
                onChange={e => updateProposal({ deliveryTerms: e.target.value })}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Гарантия:</label>
              <input
                type="text"
                value={documentView.warrantyTerms}
                onChange={e => updateProposal({ warrantyTerms: e.target.value })}
                className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl"
              />
            </div>
          </div>
          </>
          )}
        </div>

        {/* Right 2 Columns: Items Table, Engineering Works, Internal Expenses & Summary */}
        {showWizardItems && (
        <div className={`space-y-6 ${managerWizard ? 'lg:col-span-3' : 'lg:col-span-2'}`}>
          {/* Items Section */}
          <div className="bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-black pb-3">
              <div>
                <h3 data-kp-field="items" className="font-black text-base uppercase tracking-wide text-slate-900">
                  {managerWizard ? 'Позиции' : 'Состав предложения (Оборудование и запчасти)'}
                </h3>
                {!managerWizard && (
                <p className="text-xs text-slate-600">
                  Вносите позиции по открытому прайсу или вручную с указанием источника
                </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                {managerWizard ? (
                  <div className="grid grid-cols-2 gap-2 w-full sm:w-auto min-w-[280px]">
                    <button
                      type="button"
                      onClick={() => { if (allowEditorAction('editItems')) setIsPriceBookOpen(true); }}
                      className="px-3 py-2.5 bg-amber-400 hover:bg-amber-300 text-black border-2 border-black rounded-xl font-black text-xs shadow-[2px_2px_0px_#000]"
                    >
                      + Из прайса
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAddItem()}
                      className="px-3 py-2.5 bg-stone-100 hover:bg-stone-200 text-black border-2 border-black rounded-xl font-black text-xs shadow-[2px_2px_0px_#000]"
                    >
                      + Ввести вручную
                    </button>
                  </div>
                ) : (
                <>
                <button
                  type="button"
                  onClick={() => { if (allowEditorAction('editItems')) setIsPriceBookOpen(true); }}
                  className="px-3 py-1.5 bg-amber-200 hover:bg-amber-300 text-slate-900 border-2 border-black rounded-xl font-bold text-xs flex items-center gap-1.5"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  Выбрать из прайса
                </button>

                <button
                  type="button"
                  onClick={() => handleAddItem()}
                  className="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-black border-2 border-black rounded-xl font-black text-xs shadow-[2px_2px_0px_#000] flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  Добавить строку
                </button>
                </>
                )}
              </div>
            </div>

            {managerWizard && (
              <p className="text-xs font-bold text-slate-700 uppercase tracking-wide">Товары и запчасти</p>
            )}

            {/* Mixed Robatech + Klerotech Alert & Split Option */}
            {isMixedBrands && !managerWizard && (
              <div className="p-4 rounded-xl border-2 border-amber-600 bg-amber-50 shadow-xs space-y-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-amber-200 text-amber-900 rounded-lg shrink-0 mt-0.5">
                    <AlertTriangle className="w-5 h-5 text-amber-800" />
                  </div>
                  <div className="flex-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-black text-amber-950 text-sm">
                        Внимание: Смешанная спецификация (Robatech + Клеротех)
                      </span>
                      <span className="px-2 py-0.5 bg-amber-200 text-amber-900 font-bold rounded text-[10px]">
                        2 юридических лица
                      </span>
                    </div>
                    <p className="text-amber-900 leading-relaxed mt-1">
                      В КП включены позиции <strong>Robatech</strong> ({robatechItems.length} поз. на {formatCurrency(sumRobatech, proposal.currency)}) 
                      и позиции <strong>Клеротех</strong> ({klerotechItems.length} поз. на {formatCurrency(sumKlerotech, proposal.currency)}).
                      Для клиента допустимо выдать единое сводное КП, но <strong>для бухгалтерии и отгрузки ОБЯЗАТЕЛЬНЫ 2 раздельных договора и счёта</strong>:
                      от ООО «Роботех» и ООО «Клеротех».
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                      {onSplitProposal && (
                        <button
                          type="button"
                          onClick={() => { if (allowEditorAction('split')) onSplitProposal(proposal); }}
                          className="px-3 py-1.5 bg-black hover:bg-neutral-800 text-amber-300 font-bold rounded-lg text-xs shadow-sm flex items-center gap-1.5 transition"
                        >
                          <Split className="w-4 h-4" />
                          Разделить на 2 раздельных КП (Роботех / Клеротех)
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => updateProposal({ mixedBrandsAcknowledged: !proposal.mixedBrandsAcknowledged })}
                        className={`px-3 py-1.5 font-bold rounded-lg text-xs border transition flex items-center gap-1.5 ${
                          proposal.mixedBrandsAcknowledged
                            ? 'bg-emerald-100 border-emerald-400 text-emerald-900'
                            : 'bg-white border-amber-400 text-amber-900 hover:bg-amber-100'
                        }`}
                      >
                        {proposal.mixedBrandsAcknowledged ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-700" />
                            Раздельные договоры учтены и согласованы
                          </>
                        ) : (
                          'Подтвердить: раздельные счета для бухгалтерии будут сформированы'
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Alert for 'set' price basis check */}
            {documentView.items.some(item => proposal.status === 'draft'
              ? validateDraftLine(item).some(error => error.code === 'set_amount_unconfirmed')
              : lineAmountNeedsConfirmation(item)) && (
              <div className="p-3 bg-amber-100 border-2 border-amber-400 rounded-xl text-xs font-bold text-amber-950 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                Внимание: у позиции выбрана цена «За комплект / позицию»! При изменении количества общая сумма не умножается автоматически. Проверьте правильность цены.
              </div>
            )}

            {/* Items Table / Cards */}
            {documentView.items.length === 0 ? (
              <div className="text-center py-10 border-2 border-dashed border-slate-300 rounded-xl p-6 bg-slate-50">
                <p className="font-bold text-slate-700">В предложении пока нет товарных позиций</p>
                <p className="text-xs text-slate-500 mt-1 mb-4">
                  Откройте каталог прайсов или добавьте строку вручную
                </p>
                <button
                  onClick={() => { if (allowEditorAction('editItems')) setIsPriceBookOpen(true); }}
                  className="px-4 py-2 bg-amber-400 font-black text-xs rounded-xl border-2 border-black shadow-[2px_2px_0px_#000] inline-flex items-center gap-2"
                >
                  <BookOpen className="w-4 h-4" />
                  Открыть каталог прайсов
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {documentView.items.map((item, index) => {
                  const draftErrors = proposal.status === 'draft' ? validateDraftLine(item) : [];
                  const managerDraftLine = managerWizard && proposal.status === 'draft';
                  const lineStarted = Boolean((item.title || '').trim());
                  const showPriceIssue = item.unitPrice <= 0 && (!managerDraftLine || lineStarted);
                  const fieldHint = (field: DraftLineField) => {
                    const error = draftLineError(draftErrors, field);
                    if (!error) return null;
                    return (
                      <span className="text-sm leading-5 text-red-700 font-bold block mt-1">{DRAFT_LINE_ERROR_TEXT[error.code]}</span>
                    );
                  };
                  return (
                  <div
                    key={item.id}
                    className={`p-4 rounded-xl border-2 transition space-y-3 ${
                      showPriceIssue
                        ? 'border-red-400 bg-red-50/30'
                        : item.isPriceModified
                        ? 'border-amber-400 bg-amber-50/20'
                        : 'border-black bg-stone-50/70 hover:bg-stone-50'
                    }`}
                  >
                    {/* Top Row: Index, Article, Title, Brand Badge, Delete */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-lg bg-black text-white font-mono text-xs font-black flex items-center justify-center shrink-0">
                          {draftLineNumber(index)}
                        </span>
                        <input
                          type="text"
                          placeholder="Артикул"
                          value={item.article}
                          onChange={e => handleUpdateItem(item.id, 'article', e.target.value)}
                          className="w-32 text-xs font-mono font-bold p-1.5 bg-white border border-black rounded-lg"
                        />
                      </div>

                      <div className="flex-1">
                        <input
                          type="text"
                          list={managerWizard && manualLineHints.length > 0 ? 'kp-manual-line-hints' : undefined}
                          data-kp-item={item.id}
                          data-kp-field="title"
                          placeholder=""
                          value={item.title}
                          onChange={e => handleUpdateItem(item.id, 'title', e.target.value)}
                          onBlur={e => applyManualLineHintOnTitleBlur(item.id, e.target.value)}
                          className="w-full text-xs font-bold p-1.5 bg-white border border-black rounded-lg"
                        />
                        {fieldHint('title')}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRemoveItem(item.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 transition"
                        title="Удалить позицию"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Description */}
                    {!managerWizard && (
                    <div>
                      <input
                        type="text"
                        placeholder=""
                        value={item.description}
                        onChange={e => handleUpdateItem(item.id, 'description', e.target.value)}
                        className="w-full text-xs p-1.5 bg-white border border-slate-300 rounded-lg text-slate-600"
                      />
                    </div>
                    )}

                    {/* Numeric parameters: Quantity, Unit, Price basis, Price, Discount */}
                    <div className={`grid gap-2 items-end ${managerWizard ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-5'}`}>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-0.5">Кол-во:</label>
                        <input
                          type="number"
                          min="1"
                          data-kp-item={item.id}
                          data-kp-field="quantity"
                          value={item.quantity}
                          onFocus={e => e.target.select()}
                          onChange={e => handleUpdateItem(item.id, 'quantity', Math.max(1, Number(e.target.value) || 1))}
                          className="w-full text-xs font-bold p-1.5 bg-white border border-black rounded-lg text-center"
                        />
                        {fieldHint('quantity')}
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-0.5">Ед. изм.:</label>
                        <select
                          data-kp-item={item.id}
                          data-kp-field="unit"
                          value={item.unit}
                          onChange={e => handleUpdateItem(item.id, 'unit', e.target.value)}
                          className="w-full text-xs font-bold p-1.5 bg-white border border-black rounded-lg"
                        >
                          <option value="шт.">шт.</option>
                          <option value="компл.">компл.</option>
                          <option value="м">м</option>
                          <option value="уп.">уп.</option>
                        </select>
                        {fieldHint('unit')}
                      </div>

                      {!managerWizard && (
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-0.5">Основа цены:</label>
                        <select
                          data-kp-item={item.id}
                          data-kp-field="priceBasis"
                          value={item.priceBasis}
                          onChange={e => handleUpdateItem(item.id, 'priceBasis', e.target.value as PriceBasis)}
                          className="w-full text-xs font-bold p-1.5 bg-white border border-black rounded-lg"
                        >
                          <option value="unit">За единицу (цена × кол-во)</option>
                          <option value="set">За комплект / позицию (фикс)</option>
                        </select>
                        {fieldHint('priceBasis')}
                        {(proposal.status === 'draft' ? Boolean(draftLineError(draftErrors, 'setAmountConfirmed')) : lineAmountNeedsConfirmation(item)) && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!allowEditorAction('editPrices')) return;
                              const items = documentView.items.map(current => current.id === item.id ? confirmSetLineAmount(current) : current);
                              commitAudit({ items }, 'line_changed', 'Изменена строка');
                            }}
                            data-kp-item={item.id}
                            data-kp-field="setAmountConfirmed"
                            className="mt-1 text-sm leading-5 font-bold text-amber-950 bg-amber-100 border border-amber-400 rounded-lg px-2 py-1"
                          >
                            Подтвердить сумму комплекта
                          </button>
                        )}
                      </div>
                      )}

                      <div>
                        <div className="flex items-center justify-between mb-0.5">
                          <label className="text-[11px] font-bold text-slate-700">Цена (EUR):</label>
                          {item.isPriceModified && item.catalogOriginalPrice !== undefined && (
                            <button
                              type="button"
                              onClick={() => handleResetItemPrice(item.id)}
                              className="text-[9px] text-blue-700 hover:underline font-bold"
                              title={`Вернуть каталожную цену ${item.catalogOriginalPrice} EUR`}
                            >
                              Прайс: {item.catalogOriginalPrice} €
                            </button>
                          )}
                        </div>
                        <DecimalInput
                          locked={sentLocked}
                          value={item.unitPrice}
                          onChange={val => handleUpdateItem(item.id, 'unitPrice', val)}
                          className={`w-full text-xs font-mono font-bold p-1.5 bg-white border rounded-lg text-right ${
                            showPriceIssue
                              ? 'border-red-500 bg-red-50 text-red-900 ring-1 ring-red-400'
                              : item.isPriceModified
                              ? 'border-amber-500 bg-amber-50/50 text-slate-900'
                              : 'border-black'
                          }`}
                        />
                        {proposal.status === 'draft' && !managerDraftLine && draftLineError(draftErrors, 'unitPrice') ? (
                          <span className="text-sm leading-5 text-red-700 font-bold block mt-1">{DRAFT_LINE_ERROR_TEXT.price_not_positive}</span>
                        ) : proposal.status === 'draft' && draftLineError(draftErrors, 'unitPrice') ? (
                          <span className="text-sm leading-5 text-red-700 font-bold block mt-1">{DRAFT_LINE_ERROR_TEXT.price_not_positive}</span>
                        ) : showPriceIssue ? (
                          <span className="text-sm leading-5 text-red-700 font-bold block mt-1">Укажите цену больше нуля</span>
                        ) : null}
                        {item.unitPrice > 100000 && (
                          <span className="text-sm leading-5 text-slate-800 font-bold block mt-1">Проверьте цену больше 100000</span>
                        )}
                        {item.isPriceModified && item.catalogOriginalPrice !== undefined && (
                          <span className="text-[10px] text-amber-700 font-semibold block mt-0.5">
                            В прайсе: {item.catalogOriginalPrice} € ({item.unitPrice > item.catalogOriginalPrice ? '+' : ''}{Math.round(((item.unitPrice - item.catalogOriginalPrice) / item.catalogOriginalPrice) * 100)}%)
                          </span>
                        )}
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-0.5">Скидка (%):</label>
                        <DiscountInput
                          locked={sentLocked}
                          value={item.discountPercent || 0}
                          onChange={val => handleUpdateItem(item.id, 'discountPercent', val)}
                        />
                        {(item.discountPercent || 0) > 20 && (
                          <span className="text-sm leading-5 text-slate-800 font-bold block mt-1 text-center">
                            Скидка больше 20%: согласовать
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Source Tag & Brand Lock */}
                    {!managerWizard ? (
                    <>
                    <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-600 text-[11px]">Каталог / Источник:</span>
                        {item.catalogBrand === 'robatech' ? (
                          <div className="flex items-center gap-1.5">
                            <span className="px-2 py-1 text-xs font-bold rounded-lg border border-black bg-emerald-100 text-emerald-950 flex items-center gap-1">
                              <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
                              Каталог Robatech (закреплено)
                            </span>
                            <select
                              value={item.source}
                              onChange={e => handleUpdateItem(item.id, 'source', e.target.value as PriceSource)}
                              className="text-xs font-bold p-1 rounded-lg border border-slate-300 bg-white"
                            >
                              <option value="robatech_price">Прайс Robatech</option>
                              <option value="manual">Спеццена (не из каталога)</option>
                            </select>
                          </div>
                        ) : item.catalogBrand === 'klerotech' ? (
                          <div className="flex items-center gap-1.5">
                            <span className="px-2 py-1 text-xs font-bold rounded-lg border border-black bg-amber-100 text-amber-950 flex items-center gap-1">
                              <ShieldCheck className="w-3.5 h-3.5 text-amber-700" />
                              Каталог Клеротех (закреплено)
                            </span>
                            <select
                              value={item.source}
                              onChange={e => handleUpdateItem(item.id, 'source', e.target.value as PriceSource)}
                              className="text-xs font-bold p-1 rounded-lg border border-slate-300 bg-white"
                            >
                              <option value="klerotech_price">Прайс Клеротех</option>
                              <option value="manual">Спеццена (не из каталога)</option>
                            </select>
                          </div>
                        ) : (
                          <select
                            value={item.source}
                            onChange={e => handleUpdateItem(item.id, 'source', e.target.value as PriceSource)}
                            className={`text-xs font-bold p-1 rounded-lg border border-black ${
                              item.source === 'klerotech_price' ? 'bg-amber-100 text-amber-900' :
                              item.source === 'robatech_price' ? 'bg-emerald-100 text-emerald-900' :
                              'bg-rose-100 text-rose-900'
                            }`}
                          >
                            <option value="klerotech_price">Внесено по прайсу Клеротех</option>
                            <option value="robatech_price">Внесено по прайсу Robatech</option>
                            <option value="manual">Не из прайса (ручной ввод)</option>
                          </select>
                        )}
                      </div>

                      {fieldHint('priceListVersion')}

                      <div className="text-right">
                        <span className="text-slate-500 text-[11px] mr-1.5">Сумма строки:</span>
                        <span className="font-mono font-black text-slate-900">
                          {formatCurrency(
                            lineBaseAmount(item.priceBasis, item.unitPrice, item.quantity) *
                            (1 - (item.discountPercent || 0) / 100),
                            proposal.currency
                          )}
                        </span>
                      </div>
                    </div>

                    {/* If manual source or price modified: mandate reason & source */}
                    {(item.source === 'manual' || item.isPriceModified) && (
                      <div className="bg-rose-50 border border-rose-300 p-2.5 rounded-xl space-y-1">
                        <label className="block text-[11px] font-bold text-rose-900">
                          {item.source === 'manual'
                            ? 'Причина цены не из каталога (обязательно для внутренних отчетов):'
                            : 'Обоснование ручного изменения цены относительно каталога:'}
                        </label>
                        <input
                          type="text"
                          data-kp-item={item.id}
                          data-kp-field="priceReason"
                          placeholder={
                            item.source === 'manual'
                              ? 'Например: Согласовано спецпредложение завода от 12.10...'
                              : 'Например: Спецскидка за объем по согласованию с РОП...'
                          }
                          value={item.priceSourceReason || ''}
                          onChange={e => handleUpdateItem(item.id, 'priceSourceReason', e.target.value)}
                          className="w-full text-xs p-1.5 bg-white border border-rose-400 rounded-lg focus:outline-none"
                        />
                        {fieldHint('priceReason')}
                        {item.source === 'manual' && (
                          <>
                            <label className="block text-[11px] font-bold text-rose-900">
                              Источник цены:
                            </label>
                            <input
                              type="text"
                              data-kp-item={item.id}
                              data-kp-field="priceSourceDetail"
                              placeholder="Например: счёт завода, письмо поставщика, договор"
                              value={item.priceSourceDetails || ''}
                              onChange={e => handleUpdateItem(item.id, 'priceSourceDetails', e.target.value)}
                              className="w-full text-xs p-1.5 bg-white border border-rose-400 rounded-lg focus:outline-none"
                            />
                            {fieldHint('priceSourceDetail')}
                          </>
                        )}
                      </div>
                    )}
                    </>
                    ) : (
                    <div className="pt-2 border-t border-slate-200 text-right text-xs">
                      <span className="text-slate-500 text-[11px] mr-1.5">Сумма строки:</span>
                      <span className="font-mono font-black text-slate-900">
                        {formatCurrency(
                          lineBaseAmount(item.priceBasis, item.unitPrice, item.quantity) *
                          (1 - (item.discountPercent || 0) / 100),
                          proposal.currency
                        )}
                      </span>
                    </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
            {managerWizard && manualLineHints.length > 0 && (
              <datalist id="kp-manual-line-hints">
                {manualLineHints.map(h => (
                  <option key={h.key} value={h.title} />
                ))}
              </datalist>
            )}
          </div>

          {/* Section: Engineer Works (Работы инженеров) */}
          <div className="bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            {managerWizard && (
              <p className="text-xs font-bold text-slate-700 uppercase tracking-wide -mb-2">Работы</p>
            )}
            <div className="flex items-center justify-between border-b-2 border-black pb-2">
              <div>
                <h3 className="font-black text-sm uppercase tracking-wide text-slate-900 flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-amber-500" />
                  {managerWizard ? 'Монтаж и сервис' : 'Работы инженеров (монтаж, сервис, пусконаладка)'}
                </h3>
                {!managerWizard && (
                <p className="text-xs text-slate-600">
                  Отдельная ручная строка для выезда, монтажа и пусконаладочных работ
                </p>
                )}
              </div>

              <button
                type="button"
                onClick={handleAddEngineerWork}
                className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-black border-2 border-black rounded-xl font-black text-xs shadow-[2px_2px_0px_#000] flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                {managerWizard ? '+ Работа' : 'Добавить работу'}
              </button>
            </div>

            {(!documentView.engineerWorks || documentView.engineerWorks.length === 0) ? (
              <p className="text-xs text-slate-500 italic py-2">
                Инженерные работы не добавлены (добавьте при необходимости шеф-монтажа или сервиса).
              </p>
            ) : (
              <div className="space-y-3">
                {documentView.engineerWorks.map((work) => (
                  <div key={work.id} className="p-3 bg-stone-50 border-2 border-black rounded-xl space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <input
                        type="text"
                        value={work.title}
                        onChange={e => handleUpdateEngineerWork(work.id, 'title', e.target.value)}
                        className="flex-1 text-xs font-bold p-1.5 bg-white border border-black rounded-lg"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveEngineerWork(work.id)}
                        className="text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs items-end">
                      <div className="col-span-2">
                        <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Описание работ:</label>
                        <input
                          type="text"
                          placeholder="Описание работ..."
                          value={work.description}
                          onChange={e => handleUpdateEngineerWork(work.id, 'description', e.target.value)}
                          className="w-full text-xs p-1.5 bg-white border border-slate-300 rounded-lg text-slate-600"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Кол-во:</label>
                        <input
                          type="number"
                          min="1"
                          value={work.quantity}
                          onChange={e => handleUpdateEngineerWork(work.id, 'quantity', Math.max(1, Number(e.target.value) || 1))}
                          className="w-full text-xs font-bold p-1.5 bg-white border border-black rounded-lg text-center"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Цена EUR:</label>
                        <DecimalInput
                          locked={sentLocked}
                          value={work.unitPrice}
                          onChange={val => handleUpdateEngineerWork(work.id, 'unitPrice', val)}
                          className="w-full text-xs font-mono font-bold p-1.5 bg-white border border-black rounded-lg text-right"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Скидка (%):</label>
                        <DiscountInput
                          locked={sentLocked}
                          value={work.discountPercent || 0}
                          onChange={val => handleUpdateEngineerWork(work.id, 'discountPercent', val)}
                        />
                      </div>
                      <div className="text-right font-mono font-black self-center text-slate-900 pb-2">
                        {formatCurrency(work.unitPrice * work.quantity * (1 - (work.discountPercent || 0) / 100), proposal.currency)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section: Internal Expenses (Скрытые расходы) */}
          {currentUser.role === 'FULL_ACCESS' && (
          <div className="bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            <div className="flex items-center justify-between border-b-2 border-black pb-2">
              <div>
                <h3 className="font-black text-sm uppercase tracking-wide text-slate-900 flex items-center gap-2">
                  <Truck className="w-4 h-4 text-indigo-600" />
                  Расходы, которые видит только менеджер (Внутренние расходы)
                </h3>
                <p className="text-xs text-slate-600">
                  Клиент их не видит отдельными строками, но суммы автоматически входят в конечную цену для заказчика
                </p>
              </div>
              <span className="text-xs font-mono font-bold bg-indigo-50 border border-indigo-200 text-indigo-800 px-2 py-0.5 rounded">
                Итого скрытых: {formatCurrency(viewed?.expenses.total ?? 0, proposal.currency)}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Доставка (внутренний расход, EUR):
                </label>
                <input
                  type="number"
                  min="0"
                  value={documentView.internalExpenses?.delivery || 0}
                  onChange={e => updateProposal({
                    internalExpenses: {
                      ...documentView.internalExpenses,
                      delivery: Number(e.target.value) || 0
                    }
                  })}
                  className="w-full text-xs font-mono font-bold p-2 bg-white border-2 border-black rounded-xl text-right"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Запуск (внутренний расход, EUR):
                </label>
                <input
                  type="number"
                  min="0"
                  value={documentView.internalExpenses?.launch || 0}
                  onChange={e => updateProposal({
                    internalExpenses: {
                      ...documentView.internalExpenses,
                      launch: Number(e.target.value) || 0
                    }
                  })}
                  className="w-full text-xs font-mono font-bold p-2 bg-white border-2 border-black rounded-xl text-right"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Прочие расходы (внутренний расход, EUR):
                </label>
                <input
                  type="number"
                  min="0"
                  value={documentView.internalExpenses?.other || 0}
                  onChange={e => updateProposal({
                    internalExpenses: {
                      ...documentView.internalExpenses,
                      other: Number(e.target.value) || 0
                    }
                  })}
                  className="w-full text-xs font-mono font-bold p-2 bg-white border-2 border-black rounded-xl text-right"
                />
              </div>
            </div>

            <div className="text-[11px] bg-indigo-50 p-3 rounded-xl border border-indigo-200 text-indigo-950 font-medium">
              <span className="font-bold">Правило распределения:</span> При показе цен клиенту по строкам эти {formatCurrency(viewed?.expenses.total ?? 0, proposal.currency)} пропорционально распределяются по товарным строкам, поэтому клиент видит аккуратные цены за штуку, а сумма строк в точности совпадает с итогом КП!
            </div>
          </div>
          )}

          {managerWizard && wizardStep === 2 && (
            <button
              type="button"
              onClick={() => setWizardStep(3)}
              className="w-full px-4 py-3 bg-black text-amber-300 font-black text-sm rounded-xl border-2 border-black shadow-[3px_3px_0px_#000]"
            >
              Далее — проверка и PDF
            </button>
          )}

          {/* Section: Final Grand Total (менеджер — только итог; общая скидка скрыта) */}
          <div className="bg-amber-300 border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_#000] space-y-4">
            {!managerWizard && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-xl bg-black text-amber-300 flex items-center justify-center font-bold">
                  <Percent className="w-5 h-5" />
                </span>
                <div>
                  <h4 className="font-black text-sm text-slate-900">Скидка на все КП (%)</h4>
                  <p className="text-xs text-slate-800">Применяется к сумме всего предложения</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={
                    documentView.overallDiscountPercent && documentView.overallDiscountPercent > 0
                      ? String(documentView.overallDiscountPercent)
                      : ''
                  }
                  placeholder=""
                  onFocus={e => e.target.select()}
                  onChange={e => {
                    const digits = sanitizeDigitString(e.target.value);
                    const n = digits === '' ? 0 : Math.min(50, parseInt(digits, 10) || 0);
                    updateProposal({ overallDiscountPercent: n });
                  }}
                  className="w-24 text-center font-black text-base p-2 bg-white border-2 border-black rounded-xl font-mono"
                />
                <span className="font-black text-lg">%</span>
              </div>
            </div>
            )}

            {managerWizard && (
              <h4 className="font-black text-sm text-slate-900">Итог по КП</h4>
            )}

            {/* Calculations breakdown */}
            <div className={`border-t-2 border-black pt-3 grid grid-cols-2 ${currentUser.role === 'FULL_ACCESS' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-3 text-xs`}>
              <div>
                <span className="text-slate-700 block">Базовая сумма товаров:</span>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {formatCurrency(viewed?.merchandiseTotal ?? 0, proposal.currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-700 block">Инженерные работы:</span>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {formatCurrency(viewed?.engineerWorksTotal ?? 0, proposal.currency)}
                </span>
              </div>
              {currentUser.role === 'FULL_ACCESS' && (
              <div>
                <span className="text-slate-700 block">Внутренние расходы:</span>
                <span className="font-mono font-bold text-slate-900 text-sm">
                  {formatCurrency(viewed?.expenses.total ?? 0, proposal.currency)}
                </span>
              </div>
              )}
              <div className="text-right sm:text-right">
                <span className="text-slate-900 font-black block uppercase">Итого для клиента:</span>
                <span className="font-mono font-black text-xl text-slate-950">
                  {formatCurrency(viewed?.grandTotal ?? 0, proposal.currency)}
                </span>
              </div>
            </div>
          </div>
        </div>
        )}
      </fieldset>
      )}

      {/* Floating Price Catalog Drawer */}
      <PriceBookDrawer
        isOpen={isPriceBookOpen}
        onClose={() => setIsPriceBookOpen(false)}
        onSelectItem={item => {
          handleAddItem({
            article: item.article,
            title: item.title,
            description: item.note || item.descriptionEn || '',
            unit: item.unit || 'шт.',
            unitPrice: item.priceWithVat,
            catalogOriginalPrice: item.priceWithVat,
            catalogBrand: item.catalog,
            isPriceModified: false,
            source: item.catalog === 'robatech' ? 'robatech_price' : 'klerotech_price',
            priceListVersion: item.catalog === 'robatech' ? ROBATECH_PRICE_LIST_VERSION : KLEROTECH_PRICE_LIST_VERSION
          });
          setIsPriceBookOpen(false);
        }}
      />

      {/* CRM Client Picker & Creator Modal */}
      <CrmClientModal
        isOpen={isCrmModalOpen}
        onClose={() => setIsCrmModalOpen(false)}
        clients={clients}
        currentUser={currentUser}
        initialMode={crmModalMode}
        onSelectClient={client => { if (allowEditorAction('editClient')) handleClientSelect(client); }}
        onAddNewClient={client => onAddNewClient(client)}
        writeToCrm={true}
      />

      {/* Version History Drawer */}
      <VersionHistoryDrawer
        isOpen={isVersionHistoryOpen}
        onClose={() => setIsVersionHistoryOpen(false)}
        proposal={proposal}
        onRestoreVersion={handleRestoreVersion}
        canRestore={allowEditorAction('restore')}
        onPreviewVersionPdf={onOpenPdf}
      />

      {/* Template Settings Modal */}
      <TemplateSettingsModal
        isOpen={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        config={releasedSurface ? releasedSurface.template : (proposal.templateConfig || DEFAULT_TEMPLATE_CONFIG)}
        onSaveConfig={updatedConfig => { if (allowEditorAction('editTemplate')) updateProposal({ templateConfig: updatedConfig }); }}
      />

      {/* Price Reconciliation Modal */}
      <PriceReconciliationModal
        isOpen={isReconciliationOpen}
        onClose={() => setIsReconciliationOpen(false)}
        proposal={proposal}
        onApplyChanges={handleApplyReconciliation}
      />
    </div>
  );
};
