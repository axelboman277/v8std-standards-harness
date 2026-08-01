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
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
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

// --- итог --------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
