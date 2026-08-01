#!/usr/bin/env node
// Смоук-тест валидатора evidence.
//
// Покрывает две группы:
//   1. Формат записей — positive/negative фикстуры по каждому семейству ID.
//   2. Fail-open регрессии — случаи, когда валидатор МОЛЧА пропускал бы нарушение.
//      Эта группа важнее первой: сломанный формат заметен, молчаливый пропуск — нет.
//
// Запуск: node v8std-evidence-validator.smoke.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const VALIDATOR = join(dirname(fileURLToPath(import.meta.url)), 'v8std-evidence-validator.mjs');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Создаёт временный каталог: files = {relativePath: content}, затем запускает валидатор.
function run(files, { profile, config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'v8std-smoke-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    if (config) writeFileSync(join(dir, 'v8std.config.json'), JSON.stringify(config), 'utf8');
    const args = [VALIDATOR, 'validate-pack', dir];
    if (profile) args.push(`--${profile}`);
    // cwd — временный каталог: иначе валидатор подхватит v8std.config.json проекта,
    // в котором запущены тесты, и результат станет зависеть от места запуска.
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dir });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const evidence = lines => `# Log\n\n## v8std evidence\n\n${lines.join('\n')}\n`;

const APPLIED = '[v8std applied: phase=implement, scope=document-posting, ids_checked=[std450,std603], conclusion=clean]';
const SENTINEL = '[v8std sentinel: id=std450, status=found, phase=implement]';
const DISCOVERED_NOT_RELEVANT = '[v8std discovered: phase=implement, scope=document-posting, query="проведение документа", top_ids=[std450,std733], new_ids=[std733], decision=not_relevant]';
const DISCOVERED_APPLIED = '[v8std discovered: phase=implement, scope=document-posting, query="проведение документа", top_ids=[std450,std733], new_ids=[std733], decision=applied]';

// --- 1. Формат записей -------------------------------------------------------

console.log('\n1. Формат записей');

{
  const { code } = run({ 'log.md': evidence([APPLIED]) });
  check('корректная applied-запись проходит', code === 0, `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=implement, scope=document-posting, ids_checked=[std450], conclusion=broken]']) });
  check('невалидный conclusion блокирует', code === 2 && /Bad conclusion/.test(out), `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=implement, scope=document-posting, ids_checked=[std450]]']) });
  check('отсутствие обязательного поля блокирует', code === 2 && /Missing required field/.test(out), `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std discovered: phase=implement, scope=x, query="q", top_ids=[std450], new_ids=[], decision=maybe]']) });
  check('неизвестный decision блокирует', code === 2 && /Unknown decision/.test(out), `exit=${code}`);
}
{
  const line = '[v8std applied: phase=implement, scope=solid-check, ids_checked=[patterns:solid:single_responsibility,acc:105,bslls:MissingSpace,v8cs:module-region-empty], conclusion=violation:acc:105]';
  const { code, out } = run({ 'log.md': evidence([line]) });
  check('все семейства ID принимаются', code === 0, `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=implement, scope=x, ids_checked=[STD-450], conclusion=clean]']) });
  check('подозрительный ID даёт WARN, не BLOCK', code === 1 && /Suspicious ID/.test(out), `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std skipped: phase=implement, scope=x, planned_ids=[std450], reason=timeout, retries=1]']) });
  check('retries<3 даёт WARN', code === 1 && /anti-pattern/.test(out), `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std unknown: phase=implement]']) });
  check('неизвестный тип записи блокирует', code === 2 && /Unknown record type/.test(out), `exit=${code}`);
}

// --- 1b. Пустые значения обязательных полей ----------------------------------

console.log('\n1b. Пустые значения (имитация проверки)');

{
  const files = { 'log.md': evidence(['[v8std sentinel: id=, status=, phase=x]']) };
  const { code, out } = run(files, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('sentinel с пустыми id/status = BLOCK', code === 2 && /Empty value/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=x, scope=y, ids_checked=[], conclusion=clean]']) });
  check('applied с пустым ids_checked = BLOCK («проверил ничего»)', code === 2 && /Empty list/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std discovered: phase=x, scope=y, query=, top_ids=[], new_ids=[], decision=noted]']) });
  check('discovered с пустым query и top_ids = BLOCK', code === 2 && /Empty (value|list)/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std skipped: phase=x, scope=y, planned_ids=[], reason=timeout, retries=3]']) });
  check('skipped с пустым planned_ids = BLOCK', code === 2 && /Empty list/.test(out), `exit=${code} ${out}`);
}
{
  const line = '[v8std discovered: phase=x, scope=y, query="проведение документа", top_ids=[std450], new_ids=[], decision=not_relevant]';
  const { code, out } = run({ 'log.md': evidence([line]) });
  check('discovered с пустым new_ids проходит (законный исход)', code === 0, `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std sentinel: id=не-id, status=found, phase=x]']) });
  check('sentinel с невалидным id = BLOCK', code === 2 && /not a valid identifier/.test(out), `exit=${code} ${out}`);
}

{
  // Конфиг с не-markdown целью. Фильтр по расширению не должен отменять явные globs,
  // иначе настроенный конфиг молча не находит записи.
  const files = { 'task-log.txt': evidence([SENTINEL, APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const config = { profile: 'gate', evidenceGlobs: ['**/task-log.txt'], sentinelId: 'std450' };
  const { code, out } = run(files, { config });
  check('evidenceGlobs на .txt: записи находятся, а не игнорируются', code === 0, `exit=${code} ${out}`);
}

// --- 1c. Типы полей и подделка формы значения --------------------------------

console.log('\n1c. Типы полей (список vs скаляр)');

{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=x, scope=y, ids_checked="[]", conclusion=clean]']) });
  check('ids_checked="[]" (строка, похожая на список) = BLOCK', code === 2 && /must be a list/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=x, scope=y, ids_checked=NOT_AN_ID, conclusion=clean]']) });
  check('ids_checked как скаляр = BLOCK', code === 2 && /must be a list/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std discovered: phase=x, scope=y, query=[], top_ids=[std450], new_ids=[], decision=noted]']) });
  check('query как список = BLOCK', code === 2 && /must be a scalar/.test(out), `exit=${code} ${out}`);
}
{
  // U+200B ZERO WIDTH SPACE — та же пустота, только незаметная
  const { code, out } = run({ 'log.md': evidence(['[v8std discovered: phase=x, scope=y, query="\u200B\u200B", top_ids=[std450], new_ids=[], decision=noted]']) });
  check('query из невидимых символов = BLOCK', code === 2 && /Empty value/.test(out), `exit=${code} ${out}`);
}

// --- 1d. Правила профиля gate -------------------------------------------------

console.log('\n1d. Правила gate');

{
  const files = { 'log.md': evidence(['[v8std sentinel: id=std450, status=not_found, phase=x]', APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const { code, out } = run(files, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('gate: sentinel status=not_found = BLOCK (индекс протух)', code === 2 && /stale or unavailable/.test(out), `exit=${code} ${out}`);
}
{
  const files = { 'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const { code, out } = run(files, { profile: 'gate' });
  check('gate без sentinelId в конфиге = BLOCK', code === 2 && /requires a valid "sentinelId"/.test(out), `exit=${code} ${out}`);
}
{
  const files = { 'log.md': evidence([SENTINEL, '[v8std sentinel: id=std999, status=found, phase=x]', APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const { code, out } = run(files, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('gate: второй sentinel с чужим id = BLOCK', code === 2 && /does not match configured/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': `# Док\n\n## v8std evidence example\n\n${APPLIED}\n${SENTINEL}\n` }, { profile: 'gate' });
  check('заголовок "## v8std evidence example" не считается секцией', code === 2 && /No v8std evidence records/.test(out), `exit=${code} ${out}`);
}

// --- 1e. Кодировка файла и закомментированные записи -------------------------

console.log('\n1e. BOM, переносы строк, HTML-комментарии');

{
  // BOM появляется сам собой в Windows-редакторах. С ним первая строка перестаёт
  // совпадать с заголовком секции, и весь файл молча считался пустым.
  const withBom = `﻿# Журнал

## v8std evidence

${SENTINEL}
${APPLIED}
${DISCOVERED_NOT_RELEVANT}
`;
  const { code, out } = run({ 'log.md': withBom }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('BOM + CRLF: файл читается нормально', code === 0, `exit=${code} ${out}`);
}
{
  const onlyCommented = `# Журнал\n\n## v8std evidence\n\n<!--\n${SENTINEL}\n${APPLIED}\n-->\n`;
  const { code, out } = run({ 'log.md': onlyCommented }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('только закомментированные записи = BLOCK (выключенная работа не считается)', code === 2 && /No v8std evidence records/.test(out), `exit=${code} ${out}`);
}
{
  const mixed = `# Журнал\n\n## v8std evidence\n\n<!-- отключено:\n[v8std applied: phase=x, scope=y, ids_checked=[], conclusion=clean]\n-->\n\n${SENTINEL}\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n`;
  const { code, out } = run({ 'log.md': mixed }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('комментарий пропущен, живые записи рядом читаются', code === 0, `exit=${code} ${out}`);
}

// --- 1f. Обходы через структуру записи и разметку -----------------------------

console.log('\n1f. Дубли ключей, границы блоков, malformed');

{
  const line = '[v8std sentinel: id=std450, status=not_found, status=found, phase=x]';
  const { code, out } = run({ 'log.md': evidence([line]) }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('дубль status (not_found → found) = BLOCK', code === 2 && /Duplicate field/.test(out), `exit=${code} ${out}`);
}
{
  const line = '[v8std discovered: phase=x, scope=y, query="q", top_ids=[std450], new_ids=[std733], new_ids=[], decision=applied]';
  const { code, out } = run({ 'log.md': evidence([line, SENTINEL]) });
  check('дубль new_ids (обход promote) = BLOCK', code === 2 && /Duplicate field/.test(out), `exit=${code} ${out}`);
}
{
  // Четырёхсимвольное ограждение нельзя закрыть тройным: иначе остаток документации
  // ошибочно становится «данными».
  const doc = `# Док\n\n\`\`\`\`markdown\n## v8std evidence\n\n\`\`\`\n${SENTINEL}\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n\`\`\`\`\n`;
  const { code, out } = run({ 'INSTALL.md': doc }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('```` не закрывается ``` — пример остаётся примером', code === 2 && /No v8std evidence records/.test(out), `exit=${code} ${out}`);
}
{
  const doc = `# Журнал\n\n## v8std evidence\n\n\`\`\`\n<!--\n${SENTINEL}\n${APPLIED}\n-->\n\`\`\`\n`;
  const { code, out } = run({ 'log.md': doc }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('закомментированные записи внутри код-блока не считаются', code === 2 && /No v8std evidence records/.test(out), `exit=${code} ${out}`);
}
{
  const doc = `## v8std evidence\n\n${SENTINEL}\n\n# Другой раздел\n\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n`;
  const { code, out } = run({ 'log.md': doc }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('H1 завершает секцию — записи из чужого раздела не засчитываются', code === 2, `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied phase=x, scope=y, ids_checked=[std450], conclusion=clean]']) });
  check('запись без двоеточия = BLOCK, а не игнор', code === 2 && /Malformed/.test(out), `exit=${code} ${out}`);
}
{
  // Setext-заголовок: текст, подчёркнутый ===. Тот же класс, что H1, но другой синтаксис.
  const doc = `## v8std evidence\n\n${SENTINEL}\n\nЧужой раздел\n============\n\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n`;
  const { code, out } = run({ 'log.md': doc }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('setext-заголовок завершает секцию', code === 2, `exit=${code} ${out}`);
}
{
  // Контроль: таблица внутри секции не должна восприниматься как setext-заголовок.
  const doc = `## v8std evidence\n\n| поле | знач |\n|---|---|\n| a | b |\n\n${SENTINEL}\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n`;
  const { code, out } = run({ 'log.md': doc }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('таблица в секции не обрывает её', code === 0, `exit=${code} ${out}`);
}
{
  const doc = `## v8std evidence\n\n[v8std applied:\n phase=x, scope=y, ids_checked=[std450], conclusion=clean]\n`;
  const { code, out } = run({ 'log.md': doc });
  check('многострочная запись = BLOCK', code === 2 && /Malformed/.test(out), `exit=${code} ${out}`);
}

// --- 1g. Промоут-гейт и конфиг ------------------------------------------------

console.log('\n1g. Промоут-гейт и схема конфига');

{
  const files = {
    'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_APPLIED]),
    'final-report.md': '# Отчёт\n\n## v8std discoveries to promote\n\nTODO\n',
  };
  const { code, out } = run(files);
  check('promote-секция из одного «TODO» = BLOCK (ID не назван)', code === 2 && /is not mentioned/.test(out), `exit=${code} ${out}`);
}
{
  const files = {
    'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_APPLIED]),
    'final-report.md': '# Отчёт\n\n## v8std discoveries to promote example\n\nstd733 — пример.\n',
  };
  const { code, out } = run(files);
  check('заголовок promote с суффиксом example не считается секцией', code === 2 && /is missing/.test(out), `exit=${code} ${out}`);
}
{
  const files = { 'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_APPLIED]) };
  const config = { promoteReport: '../outside-report.md' };
  const { code, out } = run(files, { config });
  check('promoteReport за пределами каталога = BLOCK', code === 2 && /outside the checked directory/.test(out), `exit=${code} ${out}`);
}
{
  const files = { 'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const { code, out } = run(files, { config: { profile: 'gate', phases: 'design', sentinelId: 'std450' } });
  check('phases строкой вместо массива = BLOCK, а не молчаливое отключение', code === 2 && /must be an array/.test(out), `exit=${code} ${out}`);
}
{
  const files = { 'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const { code, out } = run(files, { config: { evidenceGlobs: '**/*.md' } });
  check('evidenceGlobs строкой = BLOCK, а не падение процесса', code === 2 && /must be an array/.test(out), `exit=${code} ${out}`);
}
{
  const files = { 'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_NOT_RELEVANT]) };
  const { code, out } = run(files, { config: { profile: 'mystery', sentinelId: 'std450' } });
  check('неизвестный profile = BLOCK, а не понижение до lint', code === 2 && /Unknown profile/.test(out), `exit=${code} ${out}`);
}
{
  // Список из одного элемента в кавычках с запятой внутри: формально непуст,
  // но ни одного проверяемого ID не содержит.
  const line = '[v8std applied: phase=x, scope=y, ids_checked=["std450,std603"], conclusion=clean]';
  const { code, out } = run({ 'log.md': evidence([line, SENTINEL, '[v8std skipped: phase=x, scope=y, planned_ids=[std1], reason=timeout, retries=3]']) }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('gate: нераспознанный ID = BLOCK (в lint остаётся WARN)', code === 2 && /Suspicious ID/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence(['[v8std applied: phase=x, scope=y, ids_checked=[STD-450], conclusion=clean]']) }, { profile: 'lint' });
  check('lint: нераспознанный ID остаётся WARN', code === 1 && /Suspicious ID/.test(out), `exit=${code} ${out}`);
}
{
  const files = {
    'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_APPLIED]),
    'final-report.md': '# Отчёт\n\n## v8std discoveries to promote\n\nрешение ниже\n<!--\nstd733 — берём\n',
  };
  const { code, out } = run(files, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('promote: ID только в незакрытом комментарии = BLOCK', code === 2 && /is not mentioned/.test(out), `exit=${code} ${out}`);
}
{
  const files = {
    'log.md': evidence([SENTINEL, APPLIED, DISCOVERED_APPLIED]),
    'final-report.md': '# Отчёт\n\n## v8std discoveries to promote\n\nрешение\n\n```\nstd733\n```\n',
  };
  const { code, out } = run(files, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('promote: ID только внутри код-блока = BLOCK', code === 2 && /is not mentioned/.test(out), `exit=${code} ${out}`);
}
{
  const doc = `## v8std evidence\n\n<!-- <!-- -->\n[v8std applied phase=x, ids_checked=[std450]]\n${SENTINEL}\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n`;
  const { code, out } = run({ 'log.md': doc }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('вложенный комментарий не скрывает повреждённую запись', code === 2 && /Malformed/.test(out), `exit=${code} ${out}`);
}

// --- 2. Fail-open регрессии --------------------------------------------------

console.log('\n2. Fail-open регрессии (главная группа)');

{
  const { code, out } = run({ 'readme.md': '# Пусто, ни одной записи\n' }, { profile: 'gate' });
  check('gate: ноль записей = BLOCK, а не «чисто»', code === 2 && /No v8std evidence records/.test(out), `exit=${code}`);
}
{
  const { code } = run({ 'readme.md': '# Пусто, ни одной записи\n' }, { profile: 'lint' });
  check('lint: ноль записей = чисто (профиль осознанно мягкий)', code === 0);
}
{
  const { code, out } = run({ 'log.md': evidence([APPLIED, DISCOVERED_APPLIED, SENTINEL]) });
  check('discovered+applied без promote-секции = BLOCK', code === 2 && /discoveries to promote/.test(out), `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence([APPLIED, DISCOVERED_NOT_RELEVANT, SENTINEL]) });
  check('discovered+not_relevant без final-report = чисто (отвергнутый стандарт не продвигают)', code === 0, `exit=${code} ${out}`);
}
{
  const files = {
    'log.md': evidence([APPLIED, DISCOVERED_APPLIED, SENTINEL]),
    'final-report.md': '# Отчёт\n\n## v8std discoveries to promote\n\nstd733 — добавить в карту.\n',
  };
  const { code, out } = run(files);
  check('discovered+applied с непустой promote-секцией = чисто', code === 0, `exit=${code} ${out}`);
}
{
  const files = {
    'log.md': evidence([APPLIED, DISCOVERED_APPLIED, SENTINEL]),
    'final-report.md': '# Отчёт\n\n## v8std discoveries to promote\n\n<!-- заполнить -->\n',
  };
  const { code, out } = run(files);
  check('promote-секция из одних комментариев = BLOCK', code === 2 && /is empty/.test(out), `exit=${code}`);
}
{
  // Нестандартная раскладка: если бы разрешение путей чинилось не во всех функциях,
  // промоут-гейт молча не нашёл бы ни записи, ни отчёт.
  const files = {
    'docs/notes/task-log.md': evidence([APPLIED, DISCOVERED_APPLIED, SENTINEL]),
  };
  const config = { evidenceGlobs: ['**/task-log.md'], promoteReport: 'docs/notes/report.md' };
  const { code, out } = run(files, { config });
  check('нестандартные пути: промоут-гейт всё равно срабатывает', code === 2 && /discoveries to promote/.test(out), `exit=${code} ${out}`);
}
{
  const { code, out } = run({ 'log.md': evidence([APPLIED, DISCOVERED_NOT_RELEVANT]) }, { profile: 'gate' });
  check('gate: нет sentinel-записи = BLOCK', code === 2 && /sentinel/.test(out), `exit=${code}`);
}
{
  const { code, out } = run({ 'log.md': evidence([APPLIED, SENTINEL]) }, { profile: 'gate' });
  check('gate: нет discovery и нет skip = BLOCK', code === 2 && /proactive discovery/.test(out), `exit=${code}`);
}
{
  const files = { 'log.md': evidence(['[v8std sentinel: id=std123, status=found, phase=implement]']) };
  const { code, out } = run(files, { config: { sentinelId: 'std450' } });
  check('sentinel с чужим id = BLOCK (дрейфующий sentinel ничего не детектирует)', code === 2 && /does not match configured/.test(out), `exit=${code}`);
}
{
  const files = { 'log.md': evidence([APPLIED, DISCOVERED_NOT_RELEVANT, SENTINEL]) };
  const config = { profile: 'gate', phases: ['design', 'implement', 'review'], sentinelId: 'std450' };
  const { code, out } = run(files, { config });
  check('gate: фаза без единой записи даёт WARN', code === 1 && /phases without any evidence/.test(out), `exit=${code} ${out}`);
}
{
  // Самоотравление документацией: примеры внутри ``` не должны считаться данными.
  // Иначе положенный в репозиторий пакет сам себя «удовлетворяет» и гейт вечно зелёный.
  const doc = [
    '# Инструкция',
    '',
    'Минимальный носитель выглядит так:',
    '',
    '```markdown',
    '## v8std evidence',
    '',
    SENTINEL,
    APPLIED,
    '```',
    '',
    'Конец примера.',
  ].join('\n');
  const { code, out } = run({ 'INSTALL.md': doc }, { profile: 'gate' });
  check('gate: примеры в код-блоках не считаются записями', code === 2 && /No v8std evidence records/.test(out), `exit=${code} ${out}`);
}
{
  // Обратная сторона: настоящие записи вне ограждений по-прежнему видны.
  const mixed = `# Журнал\n\n\`\`\`bsl\nПроцедура Пример()\nКонецПроцедуры\n\`\`\`\n\n## v8std evidence\n\n${SENTINEL}\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n`;
  const { code, out } = run({ 'log.md': mixed }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('gate: записи вне ограждений видны, соседний код-блок не мешает', code === 0, `exit=${code} ${out}`);
}
{
  // Реальный паттерн: заголовок секции снаружи, а сами записи агент оформил код-блоком.
  // Такие записи обязаны считаться — иначе привычка «обернуть для читаемости» делает
  // работу невидимой для гейта.
  const boxed = `# Журнал\n\n## v8std evidence\n\n\`\`\`\n${SENTINEL}\n${APPLIED}\n${DISCOVERED_NOT_RELEVANT}\n\`\`\`\n\nДетали ниже.\n`;
  const { code, out } = run({ 'log.md': boxed }, { config: { profile: 'gate', sentinelId: 'std450' } });
  check('gate: заголовок снаружи + записи в код-блоке = записи считаются', code === 0, `exit=${code} ${out}`);
}

// --- итог --------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
