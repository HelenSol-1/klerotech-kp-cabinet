# Fixik QA — канон 40/40 + live P0 (testo)

**Дата:** 2026-10-31  
**Контур:** http://127.0.0.1:3010  
**Бандл (после фикса):** `index-CZq908k8.js` (`npm run build`, kickstart `com.klerotech.kp-cabinet`)  
**КП P0:** **КП-2026-0015** (`cp-1792759380364`)  
**Исполнитель:** основной агент чата (PLUGIN_AGENT)

---

## 1. Регресс канона

**Команда:** `cd cabinet-app && npm test`

**Результат:** **40/40 PASS**, exit 0.

---

## 2. Продуктовые фиксы (Save → PUT → persistedProposal → PDF)

| Проблема | Исправление |
|----------|-------------|
| Ручная строка мастера без reason/detail | `normalizeProposalForPersist` / `proposalPersistNormalize.ts` на клиенте и в `writeStoredProposals` |
| `PUT` **403** у office_spb с «Все КП»: клиент шлёт `sanitizeProposalForRole`, guard сравнивал с полной SQLite-копией | `augmentProposalsPutPayload` в `kp_pilot_server.ts` перед `standingWriteStatus` |
| После успешного `PUT` PDF остаётся off: `mergeIncomingProposals` затирал `serverProposals` через `preferLocalOpen` | После `PUT 200` — прямая подстановка ответа сервера в `setServerProposals` (`App.tsx`) |

Мастер, фото, карточки, стили, роли **не менялись**.

---

## 3. Live P0 (testo / 1111), шаги 1–6

| # | Шаг | Результат | Доказательство |
|---|-----|-----------|----------------|
| 1 | Ручная строка «P0 FIX 313», цена **313** | **PASS** | UI шаг 2, `browser_type` (React onChange) |
| 2 | «Сохранить» | **PASS** | SQLite после Save: `P0 FIX 313` \| **313** |
| 3 | Сервер = редактор | **PASS** | `GET /api/kp/bootstrap` (testo): title **P0 FIX 313**, `unitPrice` **313**, `priceSourceReason` **ручной ввод менеджера** |
| 4 | PDF сразу активен | **PASS** | Шаг 3: «Предпросмотр PDF» / «Скачать PDF» **без** `disabled`, нет текста «несохранённые изменения» |
| 5 | Предпросмотр и скачанный PDF | **PASS** | Предпросмотр: строка **P0 FIX 313**, итог **313,00 EUR**; `POST /api/kp/blank-pdf` `{ id, contentRevision, version }` → **200** `application/pdf` (тот же контур, что «Скачать PDF») |
| 6 | F5 | **PASS** | После F5 шаг 3: **€ 313,00**, позиция **P0 FIX 313**, PDF активен |

**SQLite (после UI Save):**

```text
SELECT json_extract(payload_json,'$.items[0].title'),
       json_extract(payload_json,'$.items[0].unitPrice')
FROM kp_proposals WHERE number='КП-2026-0015';
→ P0 FIX 313|313
```

---

## 4. Security regression (`augmentProposalsPutPayload`)

**Команда:** `npm run test:p0-put-security` (live `:3010` + `KP_PILOT_DB`)

| Проверка | Результат |
|----------|-----------|
| testo «Все КП», свой черновик + чужие sanitized в PUT | **PASS** — PUT 200, свой маркер на сервере |
| Чужие `payload_json` после legit PUT | **PASS** — byte-identical (15 foreign ids) |
| Подмена чужого в payload | **PASS** — **403**, SQLite без изменений |
| `forbiddenForeignPutItemMutation` до reconcile | **PASS** — не silent bypass |

---

## 5. Вердикт Fixik

| Gate | Статус |
|------|--------|
| Канон `npm test` 40/40 | **[FIXIK PASS]** |
| Live P0 1–6 UI Save → SQLite/API → PDF | **[FIXIK PASS]** |
| Security P0 PUT foreign reconcile | **[FIXIK PASS]** |

**Итог для Owner:** `[FIXIK PASS: canon + P0]` — после merge PR с scope P0 persist.
