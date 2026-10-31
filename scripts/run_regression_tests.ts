import { INITIAL_PROPOSALS, MOCK_CLIENTS, INITIAL_USERS, MOCK_EQUIPMENT, MOCK_EVENTS } from '../src/data/mockData.ts';
import { runFullCanonRegressionTests } from '../src/utils/regressionTests.ts';

console.log('====================================================');
console.log('  КЛЕРОТЕХ & ROBATECH: РЕГРЕСС-ТЕСТЫ КАНОНА КП И ЛИНЗ');
console.log('====================================================\n');

const suite = runFullCanonRegressionTests(
  INITIAL_PROPOSALS,
  MOCK_CLIENTS,
  INITIAL_USERS,
  MOCK_EQUIPMENT,
  MOCK_EVENTS
);

console.log(`Время исполнения: ${suite.durationMs} мс`);
console.log(`Всего тестов: ${suite.totalTests}`);
console.log(`Успешно: ${suite.passedCount}`);
console.log(`Ошибок: ${suite.failedCount}`);
console.log('----------------------------------------------------');

suite.results.forEach((test, idx) => {
  const mark = test.passed ? '✓ [PASS]' : '✗ [FAIL]';
  console.log(`${idx + 1}. ${mark} [${test.category.toUpperCase()}] ${test.name} (${test.durationMs}ms)`);
  if (test.details) {
    console.log(`   Детали: ${test.details}`);
  }
  if (test.error) {
    console.log(`   ОШИБКА: ${test.error}`);
  }
});

console.log('----------------------------------------------------');
if (suite.status === 'ALL_PASSED') {
  console.log('\n🟢 ВСЕ РЕГРЕСС-ТЕСТЫ КАНОНА ПРОЙДЕНЫ УСПЕШНО! (100%)\n');
  process.exit(0);
} else {
  console.error('\n🔴 ОБНАРУЖЕНЫ ОТКЛОНЕНИЯ В РАСЧЕТАХ ИЛИ ДАННЫХ КАНОНА!\n');
  process.exit(1);
}
