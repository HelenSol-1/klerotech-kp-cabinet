# P0 persist — проверка PR (HelenSol-1)

## GitHub (проверяемые ссылки)

| Артефакт | URL |
|----------|-----|
| Репозиторий | https://github.com/HelenSol-1/klerotech-kp-cabinet |
| PR → `dev` | https://github.com/HelenSol-1/klerotech-kp-cabinet/pull/1 |
| Коммит P0 (head PR) | `f6c97880b9633de8cb8a22023c0717f25e366601` |
| База `dev` (пустой корень) | `2c49957c0753cb423e779bb2a31740ad1936cf4a` |
| Трекинг-issue | https://github.com/HelenSol-1/kleronewkp/issues/99 |

Репозиторий **public** (ранее был private → у части сессий давал 404). Default branch: **`dev`**.

## 10 файлов в diff PR (`dev...issue-99-p0-persist`)

1. `.gitignore`
2. `docs/FIXIK_QA_CANON_P0_2026-10-31.md`
3. `package.json` — script `test:p0-put-security`
4. `scripts/kp_pilot_server.ts` — `augmentProposalsPutPayload`, tamper guard, PUT handler
5. `scripts/run_regression_tests.ts`
6. `scripts/test_p0_put_foreign_reconcile_security.ts`
7. `src/App.tsx` — PUT payload + `setServerProposals` после 200
8. `src/components/ProposalEditor.tsx` — только `normalizeProposalForPersist` на save (без правок мастера/стилей)
9. `src/utils/proposalPersistNormalize.ts`
10. `src/utils/proposalWriteGuard.ts` — `forbiddenForeignPutItemMutation`

## `tamper → 403` — сервер, не только клиент

Порядок в `PUT /api/kp/proposals` (`scripts/kp_pilot_server.ts`):

1. **`forbiddenForeignPutItemMutation`** по каждой строке тела запроса → **403 до записи**, если чужое/sent изменено относительно sanitize-вида.
2. **`augmentProposalsPutPayload`** — подстановка канона из SQLite для read-only строк.
3. **`standingWriteStatus`** + **`writeStoredProposals`**.

Интеграционный тест бьёт **live HTTP** `:3010` + SQLite byte-compare: `npm run test:p0-put-security`.

## Локальный pilot (полное дерево)

Рабочая копия с полным `cabinet-app/` (не только 10 файлов PR-slice): `/Users/elenasol/KleroKP/cabinet-app`.  
Коммит P0 на ветке `issue-99-p0-persist` совпадает с head PR.

## Команды перед merge

```bash
cd cabinet-app
npm test
npm run test:p0-put-security   # нужен kp_pilot_server на :3010
```
