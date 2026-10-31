import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  CommercialProposal, 
  UserProfile, 
  AuditLogEntry, 
  ClientInfo, 
  ProposalVersionSnapshot,
  ProposalTemplateConfig,
  ClientEquipment,
  ClientEvent
} from './types.ts';
import { KlerotechLogo } from './components/Logos.tsx';
import { TestHelpButton } from './components/TestHelpButton.tsx';
import { 
  INITIAL_PROPOSALS, 
  INITIAL_USERS, 
  MOCK_CLIENTS, 
  DEFAULT_TEMPLATE_CONFIG,
  MOCK_EQUIPMENT,
  MOCK_EVENTS,
  calculateProposalTotals,
  getUserPermissions,
  canUseMyAllScopeToggle
} from './data/mockData.ts';
import {
  applyProposalDelete,
  applyProposalMarkSent,
  applyProposalReassign,
  applyProposalSave,
  applyProposalSplit,
  isProposalEditorActionAllowed,
  isSentProposalLocked,
  previewProposalAfterPdfEdit
} from './utils/proposalLifecycle.ts';
import { hashForView, viewForHash, type AppRouteView } from './utils/appRoutes.ts';
import { finalizeLinePriceOrigin } from './utils/proposalLineSource.ts';
import { fetchKpBlankPdf } from './utils/kpPdfRequest.ts';
import { mergeIncomingProposals, type EditorSession } from './utils/proposalEditorSession.ts';
import { classifyProposalWrite } from './utils/proposalWriteGuard.ts';
import { normalizeProposalForPersist } from './utils/proposalPersistNormalize.ts';
import type { ManualLineHint } from './utils/manualLineHints.ts';
import { Navbar } from './components/Navbar.tsx';
import { ProposalsList } from './components/ProposalsList.tsx';
import { ProposalEditor } from './components/ProposalEditor.tsx';
import { PdfViewModal } from './components/PdfViewModal.tsx';
import { PriceAuditModal } from './components/PriceAuditModal.tsx';
import { appendProposalAudit } from './utils/proposalAudit.ts';
import { commitProposalMarkSent } from './utils/proposalSentCommit.ts';
import { createSplitProposals, detachReleasedDocument, ensureReleasedDocumentSnapshot, sealReleasedDocument } from './utils/proposalDocumentSnapshot.ts';
import { EmailTextModal } from './components/EmailTextModal.tsx';
import { PriceBookDrawer } from './components/PriceBookDrawer.tsx';
import { DirectorPanel } from './components/DirectorPanel.tsx';
import { CrmClientModal } from './components/CrmClientModal.tsx';
import { VersionHistoryDrawer } from './components/VersionHistoryDrawer.tsx';
import { TemplateSettingsModal } from './components/TemplateSettingsModal.tsx';
import { CrmClientsDirectory } from './components/CrmClientsDirectory.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { WorkLensesPage } from './components/WorkLensesPage.tsx';
import { McrmCase } from './types/mcrm.ts';
import { INITIAL_MCRM_CASES } from './data/mockMcrmData.ts';
import { McrmWorkplace } from './components/mcrm/McrmWorkplace.tsx';

const STORAGE_KEY_PROPOSALS = 'klerotech_proposals_v1.3';
const STORAGE_KEY_USERS = 'klerotech_users_v1.3';
const STORAGE_KEY_CLIENTS = 'klerotech_crm_clients_v1.3';
const STORAGE_KEY_EQUIPMENT = 'klerotech_equipment_v1.3';
const STORAGE_KEY_EVENTS = 'klerotech_events_v1.3';
const STORAGE_KEY_MCRM_CASES = 'klerotech_mcrm_cases_v1.0';

// Rule from TZ: #/work is the compact home for Elena (Soldatova), Yurin and Timofeev
const isSalesShellUser = (u: UserProfile | undefined) =>
  !!u && (u.presetId === 'office_spb' || u.presetId === 'regional_manager');

export const isShortMainUser = (u: UserProfile) => {
  if (!u) return false;
  return u.id === 'user-soldatova' || u.name.includes('Елена') || u.id === 'user-yurin' || u.id === 'user-timofeev';
};

function clientBelongsToUser(client: ClientInfo, user: UserProfile): boolean {
  if (client.assignedManagerId && client.assignedManagerId === user.id) return true;
  const manager = (client.assignedManagerName || '').trim().toLowerCase();
  const name = user.name.trim().toLowerCase();
  return manager.length > 0 && manager === name;
}

export default function App() {
  // Load users from server storage (populated by /api/kp/bootstrap)
  const [users, setUsers] = useState<UserProfile[]>(() => INITIAL_USERS);

  // Current active user resolved strictly from server session
  const [currentUser, setCurrentUser] = useState<UserProfile>(() => INITIAL_USERS[0]);
  const [authStatus, setAuthStatus] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking');
  const [loginInput, setLoginInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const skipNextProposalsPush = useRef(true);
  const skipNextUsersPush = useRef(true);
  const editorSessionRef = useRef<EditorSession | null>(null);
  const proposalsSyncGenerationRef = useRef(0);

  const [hiddenProposalIds, setHiddenProposalIds] = useState<string[]>([]);
  const [manualLineHints, setManualLineHints] = useState<ManualLineHint[]>([]);
  const [showHiddenInList, setShowHiddenInList] = useState(false);

  // No general CRM list in KP pilot: client is a document-only snapshot
  const [clients, setClients] = useState<ClientInfo[]>(() => []);

  // §57: Equipment Fleet (read-only fixture, not persisted to localStorage)
  const [equipment] = useState<ClientEquipment[]>(() => MOCK_EQUIPMENT);

  // §57: Client Events (read-only fixture, not persisted to localStorage)
  const [events] = useState<ClientEvent[]>(() => MOCK_EVENTS);

  // Load proposals from server storage (populated by /api/kp/bootstrap)
  const [proposals, setProposals] = useState<CommercialProposal[]>(() =>
    INITIAL_PROPOSALS.map(ensureReleasedDocumentSnapshot)
  );
  /** Последнее состояние, подтверждённое сервером (для PDF и «несохранённых») */
  const [serverProposals, setServerProposals] = useState<CommercialProposal[]>(() =>
    INITIAL_PROPOSALS.map(ensureReleasedDocumentSnapshot)
  );

  // MCRM Cases (read-only fixture, not persisted to localStorage)
  const [cases, setCases] = useState<McrmCase[]>(() => INITIAL_MCRM_CASES);

  // Navigation View: #/mcrm, #/work, #/my_proposals, etc.
  const [activeView, setActiveView] = useState<AppRouteView>(() => {
    if (typeof window !== 'undefined' && window.location.hash && window.location.hash !== '#/') {
      const fromHash = viewForHash(window.location.hash);
      if (fromHash) return fromHash;
    }
    const initialUser = users[0] || INITIAL_USERS[0];
    return isShortMainUser(initialUser) ? 'work' : 'my_proposals';
  });

  // Sync hash routing
  useEffect(() => {
    const handleHash = () => {
      const nextView = viewForHash(window.location.hash);
      if (nextView) setActiveView(nextView);
    };
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  const scopePermissions = getUserPermissions(currentUser);
  const canChooseScope = canUseMyAllScopeToggle(scopePermissions);
  const [seeAllRecords, setSeeAllRecords] = useState(false);
  useEffect(() => {
    if (!canChooseScope) {
      setSeeAllRecords(false);
      return;
    }
    if (activeView === 'all_proposals') setSeeAllRecords(true);
    if (activeView === 'my_proposals') setSeeAllRecords(false);
  }, [canChooseScope, activeView]);

  /**
   * Единый контур «Мои / Все» (только офис с обоими правами):
   * — региональный: canChooseScope false → всегда только свои клиенты и свои КП;
   * — офис «Мои»: клиенты и выбор в КП только закреплённые;
   * — офис «Все»: вся база контрагентов + чужие КП в списке.
   */
  const officeScopeAll = canChooseScope && seeAllRecords;

  const visibleClients = useMemo(() => {
    if (officeScopeAll && scopePermissions.canAccessAllClients) return clients;
    return clients.filter(client => clientBelongsToUser(client, currentUser));
  }, [clients, officeScopeAll, scopePermissions.canAccessAllClients, currentUser]);

  const handleChangeView = (view: AppRouteView) => {
    setActiveView(view);
    if (typeof window !== 'undefined') {
      window.location.hash = hashForView(view);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/kp/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } catch {
      // ignore network error on logout
    }
    setServerReady(false);
    setEditingProposalId(null);
    setProposals([]);
    setServerProposals([]);
    setAuthStatus('unauthenticated');
    setPasswordInput('');
  };

  // Client-side user switcher cannot elevate privileges: switching user requires a fresh server session login.
  const handleSwitchUser = (user: UserProfile) => {
    const tester = currentUser.id.startsWith('kp-test-') || currentUser.name.startsWith('ТЕСТ');
    const targetIsTest = user.id.startsWith('kp-test-') || user.name.startsWith('ТЕСТ');
    if (!tester || !targetIsTest || user.id === currentUser.id) return;
    setLoginInput(user.id);
    setLoginError('');
    void handleLogout();
  };

  const openProposalEditor = (propId: string) => {
    editorSessionRef.current = {
      proposalId: propId,
      sessionSeq: (editorSessionRef.current?.sessionSeq ?? 0) + 1,
      editGeneration: 0
    };
    setEditingProposalId(propId);
  };

  const bumpEditorEditGeneration = () => {
    const session = editorSessionRef.current;
    if (!session) return;
    editorSessionRef.current = { ...session, editGeneration: session.editGeneration + 1 };
  };

  const persistListHidden = async (proposalId: string, hidden: boolean) => {
    try {
      const res = await fetch('/api/kp/list-hidden', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, hidden })
      });
      if (!res.ok) return;
      const data = (await res.json()) as { hiddenProposalIds?: string[] };
      if (Array.isArray(data.hiddenProposalIds)) {
        setHiddenProposalIds(data.hiddenProposalIds);
      }
    } catch {
      // ignore — list stays as last server state
    }
  };

  // Active Proposal being edited
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editorFocus, setEditorFocus] = useState<{ field: string; itemId?: string } | null>(null);

  // Active Modals
  const [pdfModalProposal, setPdfModalProposal] = useState<CommercialProposal | null>(null);
  const [auditModalProposal, setAuditModalProposal] = useState<CommercialProposal | null>(null);
  const [emailModalProposal, setEmailModalProposal] = useState<CommercialProposal | null>(null);
  const [versionHistoryProposal, setVersionHistoryProposal] = useState<CommercialProposal | null>(null);
  const [templateSettingsProposal, setTemplateSettingsProposal] = useState<CommercialProposal | null>(null);
  const [isPriceBookOpen, setIsPriceBookOpen] = useState(false);
  const [isCrmModalOpen, setIsCrmModalOpen] = useState(false);
  const [crmModalMode, setCrmModalMode] = useState<'list' | 'create'>('list');

  const handleOpenCrmModal = (mode: 'list' | 'create' = 'list') => {
    setCrmModalMode(mode);
    setIsCrmModalOpen(true);
  };

  const applyBootstrapPayload = (
    data: {
      actor?: UserProfile;
      users?: UserProfile[];
      proposals?: CommercialProposal[];
      clients?: ClientInfo[];
      hiddenProposalIds?: string[];
      manualLineHints?: ManualLineHint[];
    },
    requestGeneration?: number
  ) => {
    if (data.actor) {
      setCurrentUser(data.actor);
      if (isSalesShellUser(data.actor)) {
        setSeeAllRecords(false);
        setActiveView('my_proposals');
      }
    }
    if (Array.isArray(data.users) && data.users.length > 0) {
      skipNextUsersPush.current = true;
      setUsers(data.users);
    } else if (data.actor) {
      skipNextUsersPush.current = true;
      setUsers([data.actor]);
    }
    if (Array.isArray(data.proposals)) {
      skipNextProposalsPush.current = true;
      const incoming = data.proposals.map(p =>
        ensureReleasedDocumentSnapshot({
          ...p,
          contentRevision: p.contentRevision ?? 1,
          templateConfig: p.templateConfig || { ...DEFAULT_TEMPLATE_CONFIG },
          versions: p.versions || []
        })
      );
      setProposals(prev =>
        mergeIncomingProposals(prev, incoming, editorSessionRef.current, requestGeneration ?? 0)
      );
      setServerProposals(prev =>
        mergeIncomingProposals(prev, incoming, editorSessionRef.current, requestGeneration ?? 0)
      );
    }
    if (Array.isArray(data.hiddenProposalIds)) {
      setHiddenProposalIds(data.hiddenProposalIds);
    }
    if (Array.isArray(data.manualLineHints)) {
      setManualLineHints(data.manualLineHints);
    }
    if (Array.isArray(data.clients)) {
      setClients(data.clients);
    }
    setServerReady(true);
    setAuthStatus('authenticated');
  };

  // Bootstrap proposals and users strictly from server session cookie (no query userId or x-kp-user-id header)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    let cancelled = false;
    fetch('/api/kp/bootstrap', {
      credentials: 'same-origin'
    })
      .then(async res => {
        if (cancelled) return;
        if (res.status === 401) {
          setServerReady(false);
          setProposals([]);
          setAuthStatus('unauthenticated');
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as {
          actor?: UserProfile;
          users?: UserProfile[];
          proposals?: CommercialProposal[];
          clients?: ClientInfo[];
        };
        if (cancelled) return;
        applyBootstrapPayload(data);
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Failed to bootstrap KP server store', err);
          // Не сбрасываем сессию при обрыве сети — только явный 401 на login/bootstrap
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginPending(true);
    try {
      const loginRes = await fetch('/api/kp/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: loginInput.trim(), password: passwordInput })
      });
      if (!loginRes.ok) {
        const errData = (await loginRes.json().catch(() => ({}))) as { error?: string };
        setLoginError(errData.error || 'Неверный логин или пароль');
        return;
      }
      setPasswordInput('');
      const bootRes = await fetch('/api/kp/bootstrap', { credentials: 'same-origin' });
      if (!bootRes.ok) {
        setLoginError('Сессия не активирована');
        return;
      }
      const bootData = (await bootRes.json()) as {
        actor?: UserProfile;
        users?: UserProfile[];
        proposals?: CommercialProposal[];
        clients?: ClientInfo[];
      };
      applyBootstrapPayload(bootData);
      if (bootData.actor) {
        if (typeof window !== 'undefined' && window.location.hash && window.location.hash !== '#/') {
          const fromHash = viewForHash(window.location.hash);
          if (fromHash) setActiveView(fromHash);
        } else {
          setActiveView(isShortMainUser(bootData.actor) ? 'work' : 'my_proposals');
        }
      }
    } catch {
      setLoginError('Ошибка соединения с сервером КП');
    } finally {
      setLoginPending(false);
    }
  };

  // Sync proposals to server SQLite store (authenticated strictly via HttpOnly session cookie)
  useEffect(() => {
    if (!serverReady || authStatus !== 'authenticated') return;
    if (skipNextProposalsPush.current) {
      skipNextProposalsPush.current = false;
      return;
    }
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    const requestGeneration = editorSessionRef.current?.editGeneration ?? 0;
    const serverById = new Map(serverProposals.map(p => [p.id, p]));
    const payloadById = new Map<string, CommercialProposal>();
    for (const p of proposals) {
      const stored = serverById.get(p.id);
      if (stored?.status === 'sent') {
        payloadById.set(p.id, stored);
        continue;
      }
      if (stored && classifyProposalWrite(currentUser, stored) !== 'accept') {
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
    const payload = [...payloadById.values()];
    proposalsSyncGenerationRef.current += 1;
    const syncId = proposalsSyncGenerationRef.current;
    fetch('/api/kp/proposals', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ proposals: payload })
    })
      .then(async res => {
        if (res.status === 401) {
          setServerReady(false);
          setAuthStatus('unauthenticated');
          return null;
        }
        if (res.status === 403 || res.status === 422) {
          // Автосинхронизация: без блокирующего alert (иначе «перезагрузка» и паника при входе)
          if (res.status === 403 && typeof console !== 'undefined') {
            console.warn('[kp] proposals PUT 403 — откат к серверной копии');
          }
          const boot = await fetch('/api/kp/bootstrap', { credentials: 'same-origin' });
          if (boot.ok) {
            const fresh = (await boot.json()) as {
              proposals?: CommercialProposal[];
              hiddenProposalIds?: string[];
            };
            if (Array.isArray(fresh.proposals)) {
              skipNextProposalsPush.current = true;
              setProposals(prev =>
                mergeIncomingProposals(
                  prev,
                  fresh.proposals.map(ensureReleasedDocumentSnapshot),
                  editorSessionRef.current,
                  requestGeneration
                )
              );
              setServerProposals(prev =>
                mergeIncomingProposals(
                  prev,
                  fresh.proposals.map(ensureReleasedDocumentSnapshot),
                  editorSessionRef.current,
                  requestGeneration
                )
              );
            }
            if (Array.isArray(fresh.hiddenProposalIds)) {
              setHiddenProposalIds(fresh.hiddenProposalIds);
            }
          }
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: { proposals?: CommercialProposal[]; manualLineHints?: ManualLineHint[] } | null) => {
        if (syncId !== proposalsSyncGenerationRef.current) return;
        if (!data || !Array.isArray(data.proposals)) return;
        skipNextProposalsPush.current = true;
        if (Array.isArray(data.manualLineHints)) {
          setManualLineHints(data.manualLineHints);
        }
        setProposals(prev => {
          const merged = mergeIncomingProposals(
            prev,
            data.proposals!.map(p =>
              ensureReleasedDocumentSnapshot({ ...p, contentRevision: p.contentRevision ?? 1 })
            ),
            editorSessionRef.current,
            requestGeneration
          );
          return merged;
        });
        // Серверная копия после успешного PUT — источник истины для persistedProposal/PDF (не preferLocalOpen).
        setServerProposals(
          data.proposals!.map(p =>
            ensureReleasedDocumentSnapshot({ ...p, contentRevision: p.contentRevision ?? 1 })
          )
        );
      })
      .catch(e => {
        console.error('Failed to save proposals to KP server store', e);
      });
  }, [proposals, serverProposals, serverReady, authStatus, currentUser.id]);

  // Sync users to server SQLite store when FULL_ACCESS updates roles
  useEffect(() => {
    if (!serverReady || authStatus !== 'authenticated') return;
    if (skipNextUsersPush.current) {
      skipNextUsersPush.current = false;
      return;
    }
    if (currentUser.role !== 'FULL_ACCESS') return;
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    fetch('/api/kp/users', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ users })
    }).catch(e => {
      console.error('Failed to save users to KP server store', e);
    });
  }, [users, serverReady, authStatus, currentUser.role]);

  // Next proposal sequential number generator (e.g. КП-2026-0007)
  const getNextProposalNumber = (): string => {
    const year = new Date().getFullYear();
    const numbers = proposals.map(p => {
      const match = p.number.match(/КП-(\d+)-(\d+)/);
      return match ? parseInt(match[2], 10) : 0;
    });
    const maxNum = numbers.length > 0 ? Math.max(...numbers, 0) : 6;
    const nextSeq = String(maxNum + 1).padStart(4, '0');
    return `КП-${year}-${nextSeq}`;
  };

  // Helper to add audit entry
  const createAuditEntry = (action: string, details?: string): AuditLogEntry => ({
    id: 'log-' + Date.now(),
    timestamp: new Date().toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }),
    userId: currentUser.id,
    userName: currentUser.name,
    action,
    details
  });

  // Helper to capture a version snapshot
  const createVersionSnapshot = (proposal: CommercialProposal, reason: string): ProposalVersionSnapshot => {
    const totals = calculateProposalTotals(proposal);
    return {
      id: 'snap-' + Date.now(),
      version: proposal.version,
      timestamp: new Date().toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      authorId: currentUser.id,
      authorName: currentUser.name,
      status: proposal.status,
      summary: reason,
      totalAmount: totals.grandTotal,
      itemsCount: proposal.items.length,
      snapshotData: JSON.parse(JSON.stringify(proposal))
    };
  };

  // Create New Proposal Draft
  const handleCreateNew = (initialClient?: ClientInfo) => {
    const nextNumber = getNextProposalNumber();
    const validityDate = new Date();
    validityDate.setMonth(validityDate.getMonth() + 1);

    const baseProposal: CommercialProposal = {
      id: 'cp-' + Date.now(),
      number: nextNumber,
      version: 1,
      rootProposalId: 'cp-root-' + Date.now(),
      status: 'draft',
      client: initialClient ? {
        ...initialClient,
        assignedManagerId: initialClient.assignedManagerId || currentUser.id,
        assignedManagerName: initialClient.assignedManagerName || currentUser.name
      } : {
        companyName: '',
        contactPerson: '',
        phone: '',
        email: '',
        region: currentUser.region,
        source: 'manual',
        assignedManagerId: currentUser.id,
        assignedManagerName: currentUser.name
      },
      authorId: currentUser.id,
      authorName: currentUser.name,
      authorTitle: currentUser.title,
      authorPhone: currentUser.phone,
      authorEmail: currentUser.email,
      authorRegion: currentUser.region,
      blankType: 'klerotech',
      proposalType: 'system',
      currency: 'EUR',
      vatRate: 20,
      showPositionPricesInPdf: true,
      deliveryMethod: 'Склад СПб',
      validityDate: validityDate.toISOString().slice(0, 10),
      paymentTerms: '100% предоплата перед отгрузкой со склада',
      deliveryTerms: 'В наличии на складе в г. Санкт-Петербург',
      warrantyTerms: '12 месяцев с момента поставки оборудования',
      items: [],
      engineerWorks: [],
      internalExpenses: {
        delivery: 0,
        launch: 0,
        other: 0
      },
      overallDiscountPercent: 0,
      templateConfig: { ...DEFAULT_TEMPLATE_CONFIG },
      versions: [],
      contentRevision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditLog: []
    };
    const drafted = appendProposalAudit(baseProposal, {
      type: 'draft_created',
      at: baseProposal.createdAt,
      userId: currentUser.id,
      userName: currentUser.name,
      action: initialClient
        ? `Создан новый черновик ${nextNumber} v1 для клиента ${initialClient.companyName} из CRM`
        : `Создан новый черновик ${nextNumber} v1`
    });

    const initialSnapshot = createVersionSnapshot(drafted, 'Создание черновика v1');
    const newProposal: CommercialProposal = {
      ...drafted,
      versions: [initialSnapshot]
    };

    setProposals(prev => dedupeProposalsFront([newProposal, ...prev]));
    openProposalEditor(newProposal.id);
  };

  function dedupeProposalsFront(list: CommercialProposal[]): CommercialProposal[] {
    const seen = new Set<string>();
    return list.filter(p => {
      if (!p?.id || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  // Save changes to proposal directly in-place
  const handleSaveProposal = (updated: CommercialProposal) => {
    bumpEditorEditGeneration();
    setProposals(prev => applyProposalSave(prev, updated));
  };

  // Release PDF after audit (and create version snapshot)
  const handleStartReleasePdf = (proposal: CommercialProposal) => {
    setAuditModalProposal(proposal);
  };

  const handleConfirmReleasePdf = (verificationNotes: string) => {
    if (!auditModalProposal) return;

    const releaseSnapshot = createVersionSnapshot(
      auditModalProposal, 
      `Выпуск официального PDF (v${auditModalProposal.version})`
    );

    const releasedAt = new Date().toISOString();
    const audited = appendProposalAudit(auditModalProposal, {
      type: 'released',
      at: releasedAt,
      userId: currentUser.id,
      userName: currentUser.name,
      action: 'Проверено и утверждено. Выпущен PDF-документ',
      version: auditModalProposal.version,
      details: verificationNotes ? `Комментарий: ${verificationNotes}` : undefined
    });
    const updatedProposal: CommercialProposal = sealReleasedDocument({
      ...audited,
      status: 'ready',
      isVerifiedByUser: true,
      verificationNotes,
      updatedAt: releasedAt,
      versions: [releaseSnapshot, ...(auditModalProposal.versions || [])]
    });

    handleSaveProposal(updatedProposal);
    setAuditModalProposal(null);
    setPdfModalProposal(updatedProposal);
  };

  // Create New Version (v1 -> v2) without overwriting existing PDF
  const handleCreateNewVersion = (proposal: CommercialProposal) => {
    const newVersionNum = proposal.version + 1;
    const versionSnapshot = createVersionSnapshot(
      proposal,
      `Фиксация ревизии перед созданием v${newVersionNum}`
    );

    const createdAt = new Date().toISOString();
    const newVersionProposal = appendProposalAudit({
      ...detachReleasedDocument(proposal),
      id: 'cp-' + Date.now(),
      version: newVersionNum,
      status: 'draft' as const,
      createdAt,
      updatedAt: createdAt,
      versions: [versionSnapshot, ...(proposal.versions || [])]
    }, {
      type: 'version_created',
      at: createdAt,
      userId: currentUser.id,
      userName: currentUser.name,
      action: `Создана новая версия ${proposal.number} v${newVersionNum} на базе v${proposal.version}`,
      version: newVersionNum
    });

    setProposals([newVersionProposal, ...proposals]);
    openProposalEditor(newVersionProposal.id);
  };

  /** Список и карточка: черновик/ready — редактор; отправленное — новая версия для правок. */
  const openProposalForEditing = (proposal: CommercialProposal) => {
    if (proposal.status === 'sent') {
      handleCreateNewVersion(proposal);
      return;
    }
    openProposalEditor(proposal.id);
  };

  // Restore snapshot version
  const handleRestoreVersionSnapshot = (snapshot: ProposalVersionSnapshot) => {
    const targetProposalId = snapshot.snapshotData.id;
    const currentProp = proposals.find(p => p.id === targetProposalId) || snapshot.snapshotData;
    const preRestoreSnapshot = createVersionSnapshot(currentProp, `Перед восстановлением из v${snapshot.version}`);

    const restored: CommercialProposal = {
      ...snapshot.snapshotData,
      id: currentProp.id,
      number: currentProp.number,
      version: currentProp.version + 1,
      updatedAt: new Date().toISOString(),
      versions: [preRestoreSnapshot, ...(currentProp.versions || [])],
      auditLog: [
        ...(currentProp.auditLog || []),
        createAuditEntry(`Восстановлено состояние из снимка v${snapshot.version} (${snapshot.timestamp})`)
      ]
    };

    handleSaveProposal(restored);
    setVersionHistoryProposal(null);
  };

  // Add new client to CRM (SQLite local contour + visible in bootstrap)
  const handleAddNewClient = async (newClient: ClientInfo): Promise<ClientInfo | null> => {
    try {
      const res = await fetch('/api/kp/clients', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newClient)
      });
      if (res.status === 401) {
        setAuthStatus('unauthenticated');
        return null;
      }
      if (!res.ok) {
        window.alert('Не удалось сохранить клиента в базе КП. Проверьте соединение и попробуйте снова.');
        return null;
      }
      const data = (await res.json()) as { client?: ClientInfo; clients?: ClientInfo[] };
      if (Array.isArray(data.clients)) {
        setClients(data.clients);
      } else if (data.client) {
        setClients(prev => [data.client!, ...prev.filter(c => c.id !== data.client!.id)]);
      }
      return data.client ?? null;
    } catch {
      window.alert('Ошибка сети при сохранении клиента.');
      return null;
    }
  };

  // Mark proposal as Sent
  const handleMarkAsSent = (proposalId: string) => {
    const fact = {
      at: new Date().toISOString(),
      userId: currentUser.id,
      userName: currentUser.name
    };
    setProposals(prev => applyProposalMarkSent(prev, proposalId, fact));
  };

  // Delete Proposal (Prohibited if status === 'sent')
  const handleDeleteProposal = (proposalId: string) => {
    const target = proposals.find(p => p.id === proposalId);
    if (!target) return;

    if (isSentProposalLocked(target)) {
      alert('Ошибка: Отправленное клиенту коммерческое предложение нельзя удалить по регламенту!');
      return;
    }

    setProposals(prev => applyProposalDelete(prev, proposalId, currentUser));
    if (editingProposalId === proposalId) {
      setEditingProposalId(null);
    }
  };

  // Split Proposal into two separate proposals (Robatech & Klerotech) for accounting & contracts
  const handleSplitProposal = (sourceProposal: CommercialProposal) => {
    const storedSource = proposals.find(p => p.id === sourceProposal.id);
    if (isSentProposalLocked(storedSource ?? sourceProposal)) return;

    const timestamp = new Date().toISOString();
    const split = createSplitProposals(sourceProposal, {
      robatech: 'cp-split-r-' + Date.now(),
      klerotech: 'cp-split-k-' + (Date.now() + 1)
    }, timestamp, action => createAuditEntry(action));
    if (!split) {
      alert('В предложении нет позиций обоих брендов для разделения.');
      return;
    }
    const { robatech: robatechProposal, klerotech: klerotechProposal } = split;

    setProposals(prev => applyProposalSplit(prev, sourceProposal.id, () => [robatechProposal, klerotechProposal]));
    setEditingProposalId(robatechProposal.id);
  };

  // Reassign all proposals from one user to another (Director tool)
  const handleTransferProposals = (fromUserId: string, toUserId: string) => {
    const toUser = users.find(u => u.id === toUserId);
    if (!toUser) return;

    setProposals(prev => applyProposalReassign(prev, fromUserId, p => ({
      ...p,
      authorId: toUser.id,
      authorName: toUser.name,
      authorTitle: toUser.title,
      authorPhone: toUser.phone,
      authorEmail: toUser.email,
      authorRegion: toUser.region,
      auditLog: [
        ...(p.auditLog || []),
        createAuditEntry(`КП передано сотруднику ${toUser.name} (${toUser.region}) в связи с перераспределением`)
      ]
    })));
  };

  // MCRM Case Management Handlers
  const handleUpdateCase = (updated: McrmCase) => {
    setCases(prev => prev.map(c => c.id === updated.id ? updated : c));
  };

  const handleCreateCase = (newCase: McrmCase) => {
    setCases(prev => [newCase, ...prev]);
  };

  const handleCreateProposalFromCase = (c: McrmCase) => {
    let clientInfo = clients.find(cl => cl.id === c.clientId || cl.companyName.toLowerCase() === c.clientName.toLowerCase());
    if (!clientInfo) {
      clientInfo = {
        id: 'client-' + Date.now(),
        companyName: c.clientName,
        region: c.clientRegion || currentUser.region || 'Санкт-Петербург',
        contactPerson: c.contactPerson || '',
        phone: c.contactPhone || '',
        email: '',
        source: 'mcrm',
        requisites: {
          inn: '',
          legalAddress: c.clientRegion || 'Санкт-Петербург'
        }
      };
      setClients(prev => [...prev, clientInfo!]);
    }

    const finalClient = clientInfo;
    const propNumber = `КП-2026-${String(proposals.length + 1).padStart(3, '0')}`;
    const newPropId = 'prop-' + Date.now();

    const newProp: CommercialProposal = {
      id: newPropId,
      number: propNumber,
      version: 1,
      rootProposalId: newPropId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      authorId: currentUser.id,
      authorName: currentUser.name,
      authorTitle: currentUser.title || 'Менеджер продаж',
      authorPhone: currentUser.phone || '',
      authorEmail: currentUser.email || '',
      authorRegion: currentUser.region || 'Санкт-Петербург',
      status: 'draft',
      blankType: 'robatech',
      proposalType: 'complex',
      vatRate: 20,
      currency: 'EUR',
      deliveryMethod: 'Склад СПб',
      validityDate: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().split('T')[0],
      deliveryTerms: 'со склада в г. Санкт-Петербург',
      paymentTerms: '50% аванс, 50% перед отгрузкой',
      warrantyTerms: '12 месяцев',
      specialConditions: `Сделка ${c.number}: ${c.title}. Оборудование: ${c.equipmentModel || 'Узел нанесения'}`,
      showPositionPricesInPdf: true,
      items: [],
      engineerWorks: [],
      internalExpenses: { delivery: 0, launch: 0, other: 0 },
      overallDiscountPercent: 0,
      client: finalClient,
      versions: [],
      auditLog: [
        {
          id: 'log-' + Date.now(),
          timestamp: new Date().toLocaleString('ru-RU'),
          userId: currentUser.id,
          userName: currentUser.name,
          action: `Создано КП по сделке ${c.number}`
        }
      ],
      templateConfig: { ...DEFAULT_TEMPLATE_CONFIG }
    };

    setProposals(prev => [newProp, ...prev]);

    const updatedCase: McrmCase = {
      ...c,
      linkedProposalId: newProp.id,
      linkedProposalNumber: newProp.number,
      timeline: [
        {
          id: 't-' + Date.now(),
          date: new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          author: currentUser.name,
          role: currentUser.role,
          text: `Создано коммерческое предложение ${newProp.number} в генераторе КП`,
          type: 'proposal_linked',
          linkedId: newProp.id
        },
        ...c.timeline
      ],
      updatedAt: new Date().toISOString()
    };
    handleUpdateCase(updatedCase);

    setEditingProposalId(newProp.id);
  };

  const editingProposal = editingProposalId ? proposals.find(p => p.id === editingProposalId) : undefined;
  const persistedEditingProposal = editingProposalId
    ? serverProposals.find(p => p.id === editingProposalId)
    : undefined;
  useEffect(() => {
    if (!serverReady || !editingProposalId || editingProposal) return;
    setEditingProposalId(null);
    editorSessionRef.current = null;
  }, [serverReady, editingProposalId, editingProposal]);

  if (authStatus !== 'authenticated') {
    return (
      <div className="min-h-screen bg-klero-dots text-slate-900 flex items-center justify-center p-4 font-sans">
        <div className="w-full max-w-md bg-white border-2 border-black rounded-2xl p-6 shadow-[4px_4px_0px_#000] space-y-5">
          <div className="border-b-2 border-black pb-4">
            <div className="flex justify-center pt-2 pb-1">
              <KlerotechLogo variant="mark" animated height={128} />
            </div>
            <span className="mt-3 inline-block px-2.5 py-0.5 bg-black text-amber-300 font-mono font-black text-[10px] rounded uppercase">
              СИСТЕМА КП
            </span>
            <div className="mt-1.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl font-black text-slate-900 leading-tight">
                  Вход в рабочий контур КП
                </h1>
                <p className="text-xs text-slate-600 mt-0.5">
                  Серверная авторизация сотрудника по логину и паролю
                </p>
              </div>
              <TestHelpButton place="login" />
            </div>
          </div>

          {authStatus === 'checking' || loginPending ? (
            <div className="py-8 flex flex-col items-center gap-3" role="status" aria-live="polite">
              <span className="h-9 w-9 rounded-full border-2 border-black border-t-amber-400 animate-spin" />
              <p className="text-sm font-black text-slate-900">
                {authStatus === 'checking' ? 'Проверяем вход' : 'Открываем кабинет'}
              </p>
              <p className="text-xs text-slate-600 text-center max-w-xs">
                Сервер сверяет учётную запись. Пока круг крутится, кабинет ещё не открыт.
              </p>
            </div>
          ) : (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Логин (ID или корпоративный e-mail):
                </label>
                <input
                  type="text"
                  autoComplete="username"
                  value={loginInput}
                  onChange={e => setLoginInput(e.target.value)}
                  placeholder="testr, testo или testd"
                  className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl font-bold focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Пароль:
                </label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passwordInput}
                  onChange={e => setPasswordInput(e.target.value)}
                  placeholder="Введите пароль"
                  className="w-full text-xs p-2.5 bg-white border-2 border-black rounded-xl font-bold focus:outline-none"
                />
              </div>

              {loginError && (
                <div className="p-2.5 bg-rose-100 border-2 border-rose-500 rounded-xl text-xs font-bold text-rose-900">
                  {loginError}
                </div>
              )}

              <button
                type="submit"
                className="w-full px-4 py-2.5 bg-amber-400 hover:bg-amber-300 text-black font-black text-xs rounded-xl border-2 border-black shadow-[3px_3px_0px_#000] transition cursor-pointer"
              >
                Войти в систему КП
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-klero-dots text-slate-900 flex flex-col font-sans">
      {/* Top Navbar */}
      <Navbar
        currentUser={currentUser}
        users={users}
        onSwitchUser={handleSwitchUser}
        onLogout={() => { void handleLogout(); }}
        activeView={activeView}
        onChangeView={view => {
          handleChangeView(view);
          setEditingProposalId(null);
        }}
        onOpenPriceBook={() => setIsPriceBookOpen(true)}
        onOpenCrmModal={() => setIsCrmModalOpen(true)}
        onCreateProposal={isSalesShellUser(currentUser) ? () => handleCreateNew() : undefined}
      />

      {/* Main Container */}
      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 flex-1">
        {editingProposal ? (
          /* Proposal Editor Mode */
          <ProposalEditor
            proposal={editingProposal}
            persistedProposal={persistedEditingProposal}
            currentUser={currentUser}
            clients={visibleClients}
            kpClientScopeAll={officeScopeAll}
            onAddNewClient={handleAddNewClient}
            onSave={handleSaveProposal}
            onBack={() => {
              setEditingProposalId(null);
              editorSessionRef.current = null;
              setEditorFocus(null);
            }}
            onReleasePdf={handleStartReleasePdf}
            onPreviewPdf={p => setPdfModalProposal(p)}
            onDownloadPdf={async p => {
              const response = await fetchKpBlankPdf(p);
              if (!response.ok) {
                window.alert('Не удалось скачать PDF.');
                return;
              }
              const blob = await response.blob();
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = `${p.number}_r${p.contentRevision ?? 1}.pdf`;
              link.click();
              URL.revokeObjectURL(link.href);
            }}
            onOpenPdf={p => setPdfModalProposal(p)}
            onOpenEmailText={p => setEmailModalProposal(p)}
            onCreateNewVersion={handleCreateNewVersion}
            onDelete={handleDeleteProposal}
            onMarkAsSent={handleMarkAsSent}
            onSplitProposal={handleSplitProposal}
            editorFocus={editorFocus}
            manualLineHints={manualLineHints}
          />
        ) : activeView === 'mcrm_workplace' ? (
          /* MCRM Canon Workplace (11 Steps & 7 Case Types) */
          <McrmWorkplace
            currentUser={currentUser}
            clients={visibleClients}
            cases={cases}
            proposals={proposals}
            onUpdateCase={handleUpdateCase}
            onCreateCase={handleCreateCase}
            onOpenProposalGenerator={() => handleChangeView('my_proposals')}
            onJumpToProposal={propId => {
              openProposalEditor(propId);
            }}
            onCreateProposalFromCase={handleCreateProposalFromCase}
          />
        ) : activeView === 'work' ? (
          /* Binocular V2 Work Page with 4 Tabs & §57 Lenses */
          <WorkLensesPage
            currentUser={currentUser}
            proposals={proposals}
            clients={visibleClients}
            equipment={equipment}
            events={events}
            users={users}
            onOpenProposal={id => openProposalEditor(id)}
            onCreateProposalForClient={client => handleCreateNew(client)}
            onOpenCrmDirectory={() => handleChangeView('crm_clients')}
          />
        ) : (activeView === 'dashboard' || activeView === 'director_panel') && currentUser.role === 'FULL_ACCESS' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Пульт">
              <button
                type="button"
                aria-pressed={activeView === 'dashboard'}
                onClick={() => handleChangeView('dashboard')}
                className={`px-3 py-1.5 rounded-xl font-black text-xs border-2 cursor-pointer ${
                  activeView === 'dashboard'
                    ? 'bg-blue-600 text-white border-black'
                    : 'bg-white text-slate-800 border-slate-300'
                }`}
              >
                Дашборд & Карта
              </button>
              <button
                type="button"
                aria-pressed={activeView === 'director_panel'}
                onClick={() => handleChangeView('director_panel')}
                className={`px-3 py-1.5 rounded-xl font-black text-xs border-2 cursor-pointer ${
                  activeView === 'director_panel'
                    ? 'bg-stone-900 text-white border-black'
                    : 'bg-white text-slate-800 border-slate-300'
                }`}
              >
                Управление
              </button>
            </div>
            {activeView === 'dashboard' ? (
          <Dashboard
            proposals={proposals}
            users={users}
            clients={visibleClients}
            currentUser={currentUser}
            onOpenProposal={p => openProposalEditor(p.id)}
            onOpenCreateProposalForClient={client => handleCreateNew(client)}
          />
            ) : (
          <DirectorPanel
            proposals={proposals}
            users={users}
            clients={visibleClients}
            equipment={equipment}
            events={events}
            onUpdateUsers={setUsers}
            onTransferProposals={handleTransferProposals}
            onSelectProposal={p => {
              openProposalEditor(p.id);
            }}
          />
            )}
          </div>
        ) : activeView === 'crm_clients' ? (
          /* CRM Clients Directory View */
          <CrmClientsDirectory
            clients={visibleClients}
            proposals={proposals}
            currentUser={currentUser}
            onOpenCreateProposalForClient={client => {
              handleCreateNew(client);
            }}
            onOpenProposal={openProposalForEditing}
            onOpenCrmModal={mode => handleOpenCrmModal(mode || 'create')}
          />
        ) : (
          /* Proposals List View (Cards & Filters) */
          <ProposalsList
            proposals={proposals}
            currentUser={currentUser}
            onCreateNew={() => handleCreateNew()}
            onOpenProposal={openProposalForEditing}
            onOpenPdf={p => setPdfModalProposal(p)}
            onOpenEmailText={p => setEmailModalProposal(p)}
            onCreateNewVersion={handleCreateNewVersion}
            onDeleteProposal={handleDeleteProposal}
            onMarkAsSent={handleMarkAsSent}
            hiddenProposalIds={hiddenProposalIds}
            showHiddenInList={showHiddenInList}
            onToggleShowHidden={() => setShowHiddenInList(v => !v)}
            onSetProposalHidden={(proposalId, hidden) => {
              void persistListHidden(proposalId, hidden);
            }}
            isAllProposalsView={officeScopeAll}
            canViewAllProposals={canChooseScope}
            onScopeChange={all => {
              if (!canChooseScope) return;
              setSeeAllRecords(all);
              handleChangeView(all ? 'all_proposals' : 'my_proposals');
            }}
            onOpenCrmModal={isSalesShellUser(currentUser) ? undefined : () => handleOpenCrmModal('list')}
            onOpenVersionHistory={p => setVersionHistoryProposal(p)}
          />
        )}
      </main>

      {/* Modals & Drawers */}

      {/* 1. PDF Preview & Print Modal */}
      {pdfModalProposal && (
        <PdfViewModal
          proposal={pdfModalProposal}
          isOpen={true}
          onClose={() => setPdfModalProposal(null)}
          onOpenEditor={() => {
            const p = pdfModalProposal;
            setPdfModalProposal(null);
            if (p) openProposalForEditing(p);
          }}
        />
      )}

      {/* 2. Price Audit and Risk Check Modal */}
      {auditModalProposal && (
        <PriceAuditModal
          proposal={auditModalProposal}
          isOpen={true}
          onClose={() => setAuditModalProposal(null)}
          onConfirmRelease={handleConfirmReleasePdf}
          onFix={target => {
            if (!auditModalProposal) return;
            setEditingProposalId(auditModalProposal.id);
            setEditorFocus(target);
            setAuditModalProposal(null);
          }}
        />
      )}

      {/* 3. Short Email Text Generator Modal */}
      {emailModalProposal && (
        <EmailTextModal
          proposal={emailModalProposal}
          isOpen={true}
          onClose={() => setEmailModalProposal(null)}
          onOpenPdf={() => {
            const p = emailModalProposal;
            setEmailModalProposal(null);
            setPdfModalProposal(p);
          }}
          onMarkAsSent={() => {
            if (!isProposalEditorActionAllowed(emailModalProposal.status, 'markSent')) return;
            handleMarkAsSent(emailModalProposal.id);
          }}
        />
      )}

      {/* 4. Price Catalog Drawer */}
      <PriceBookDrawer
        isOpen={isPriceBookOpen}
        onClose={() => setIsPriceBookOpen(false)}
        onSelectItem={
          editingProposal && isProposalEditorActionAllowed(editingProposal.status, 'editItems')
            ? item => {
                const newItem = finalizeLinePriceOrigin({
                  id: 'item-' + Date.now(),
                  article: item.article,
                  title: item.title,
                  description: item.note || item.descriptionEn || '',
                  unit: item.unit || 'шт.',
                  priceBasis: 'unit' as const,
                  quantity: 1,
                  unitPrice: item.priceWithVat,
                  discountPercent: 0,
                  source: item.catalog === 'robatech' ? 'robatech_price' as const : 'klerotech_price' as const
                });
                handleSaveProposal({
                  ...editingProposal,
                  items: [...editingProposal.items, newItem]
                });
                setIsPriceBookOpen(false);
              }
            : undefined
        }
      />

      {/* 5. CRM Client Directory & Creator Modal */}
      <CrmClientModal
        isOpen={isCrmModalOpen}
        onClose={() => setIsCrmModalOpen(false)}
        clients={visibleClients}
        currentUser={currentUser}
        initialMode={crmModalMode}
        writeToCrm={true}
        onAddNewClient={client => {
          void handleAddNewClient(client);
        }}
        onSelectClient={selectedClient => {
          if (editingProposalId) {
            const current = proposals.find(p => p.id === editingProposalId);
            if (current) {
              handleSaveProposal({
                ...current,
                client: {
                  ...selectedClient,
                  source: 'manual',
                  assignedManagerId: selectedClient.assignedManagerId || currentUser.id,
                  assignedManagerName: selectedClient.assignedManagerName || currentUser.name
                }
              });
            }
          }
        }}
      />

      {/* 6. Version History Drawer (for any proposal) */}
      {versionHistoryProposal && (
        <VersionHistoryDrawer
          isOpen={true}
          onClose={() => setVersionHistoryProposal(null)}
          proposal={versionHistoryProposal}
          onRestoreVersion={handleRestoreVersionSnapshot}
          onPreviewVersionPdf={snapshotData => setPdfModalProposal(snapshotData)}
        />
      )}

      {/* 7. Template Settings Modal (callable from PDF view or editor) */}
      {templateSettingsProposal && (
        <TemplateSettingsModal
          isOpen={true}
          onClose={() => setTemplateSettingsProposal(null)}
          config={templateSettingsProposal.templateConfig || DEFAULT_TEMPLATE_CONFIG}
          onSaveConfig={updatedConfig => {
            const updated = previewProposalAfterPdfEdit(templateSettingsProposal, { templateConfig: updatedConfig });
            if (updated === templateSettingsProposal) {
              setTemplateSettingsProposal(null);
              return;
            }
            handleSaveProposal(updated);
            if (pdfModalProposal && pdfModalProposal.id === updated.id) {
              setPdfModalProposal(updated);
            }
            setTemplateSettingsProposal(null);
          }}
        />
      )}
    </div>
  );
}
