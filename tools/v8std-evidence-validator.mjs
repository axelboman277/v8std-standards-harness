#!/usr/bin/env node
// v8std evidence validator.
//
// Проверяет секции `## v8std evidence` в рабочих артефактах: формат записей, controlled
// values, а в профиле `gate` — саму полноту проверки (наличие записей, sentinel, discovery).
//
// Профили:
//   lint — проверяет формат того, что нашёл. Ноль записей = чисто. Для ручного прогона.
//   gate — fail-closed. Ноль записей = нарушение. Для CI и pre-commit.
//
// Exit codes:
//   0 — clean
//   1 — soft warnings only (WARN)
//   2 — strict failures (BLOCK)
//
// Использование:
//   node v8std-evidence-validator.mjs validate-pack <dir> [--gate|--lint] [--config <path>]
//
// Конфиг (необязателен) — v8std.config.json рядом с каталогом или в текущем каталоге:
//   {
//     "profile": "gate",
//     "phases": ["design", "implement", "review"],
//     "evidenceGlobs": ["**/*-context.md", "**/v8std-evidence.md"],
//     "promoteReport": "final-report.md",
//     "sentinelId": "std450"
//   }
// Без конфига: профиль lint, любая непустая phase, скан всех .md в каталоге,
// promoteReport = final-report.md.

import fs from 'node:fs';
import path from 'node:path';

// --- переносимое ядро контракта (менять только вместе со SKILL.md) -----------

const RECORD_TYPES = new Set(['applied', 'skipped', 'discovered', 'sentinel']);

const REQUIRED_KEYS = {
  applied: ['phase', 'scope', 'ids_checked', 'conclusion'],
  skipped: ['phase', 'scope', 'planned_ids', 'reason', 'retries'],
  discovered: ['phase', 'scope', 'query', 'top_ids', 'new_ids', 'decision'],
  sentinel: ['id', 'status', 'phase'],
};

const SCOPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // kebab-case

// Только точный заголовок секции; допускаются лишь закрывающие решётки и пробелы.
// Уровни 2 и 3: в отчёте задачи секция часто вложена в раздел и оформляется `###`.
// Отвергать её значило бы рапортовать «записей нет» там, где они есть, — это ложное
// обвинение в пропуске проверки, худшее из возможных для такого инструмента.
const SECTION_HEADING_RE = /^(#{2,3})\s+v8std evidence\s*#*\s*$/i;

const ALLOWED_REASON = new Set([
  'mcp_unavailable_after_3_retries',
  'timeout',
  'auth_error',
  'parse_error',
  'tool_not_found',
  'no_matching_situation',
  'stale_or_unavailable_index',
]);
const ALLOWED_DECISION = new Set(['applied', 'noted', 'not_relevant']);
const ALLOWED_STATUS = new Set(['found', 'not_found']);

// Идентификаторы источников: стандарты, диагностики трёх анализаторов, паттерны
// (включая подстраницы вида patterns:solid:single_responsibility).
const SOURCE_ID = String.raw`std\d+|acc:\d+|bslls:[A-Za-z][A-Za-z0-9]*|v8cs:[a-z0-9]+(?:-[a-z0-9]+)*|patterns:[a-z]+(?:_[a-z]+)*(?::[a-z]+(?:_[a-z]+)*)*`;
const CONCLUSION_RE = new RegExp(`^(clean|violation:(?:${SOURCE_ID}))$`);
const STD_ID_RE = new RegExp(`^(?:${SOURCE_ID})$`);

// promote требуется только для решений, которые реально продвигают стандарт.
// `not_relevant` — осознанный отказ, продвигать нечего.
const PROMOTABLE_DECISIONS = new Set(['applied', 'noted']);

const DEFAULT_CONFIG = {
  profile: 'lint',
  phases: null,            // null = любая непустая метка
  evidenceGlobs: null,     // null = все .md в каталоге, рекурсивно
  promoteReport: 'final-report.md',
  sentinelId: null,        // строка или список; первый элемент — актуальный, остальные legacy
};

// Приводит sentinelId к списку. Список нужен, чтобы поднять эталон, не объявляя
// нарушителями завершённые задачи с прежним номером: новые обязаны использовать
// актуальный (первый), исторические остаются допустимыми.
function sentinelIds(config) {
  const raw = config.sentinelId;
  if (raw === null || raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String).filter(v => v.trim().length > 0);
}

const findings = []; // {severity: 'BLOCK'|'WARN', file, line, message}

function emit(severity, file, line, message) {
  findings.push({ severity, file, line, message });
}

// --- конфиг -----------------------------------------------------------------

// Чтение файла — единственная точка; ошибка ввода-вывода становится BLOCK, а не падением
// процесса с exit 1 (который CI прочитал бы как «только предупреждения»).
function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    emit('BLOCK', filePath, 0, `Cannot read file: ${error.message}`);
    return '';
  }
}

// Схема конфига. Неверный тип поля — BLOCK, а не молчаливое отключение контроля:
// `phases: "design"` (строка вместо массива) выключал фазовую проверку целиком.
function validateConfigSchema(config, source) {
  const where = source || '(config)';
  if (config.profile !== undefined && !['gate', 'lint'].includes(config.profile)) {
    emit('BLOCK', where, 0, `Unknown profile "${config.profile}" — allowed: gate, lint`);
  }
  for (const key of ['phases', 'evidenceGlobs']) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
      emit('BLOCK', where, 0, `Config field "${key}" must be an array of strings`);
      config[key] = null;
    }
  }
  if (config.promoteReport !== undefined && config.promoteReport !== null
      && typeof config.promoteReport !== 'string') {
    emit('BLOCK', where, 0, 'Config field "promoteReport" must be a string');
    config.promoteReport = null;
  }
  const sid = config.sentinelId;
  if (sid !== undefined && sid !== null) {
    const ok = typeof sid === 'string'
      || (Array.isArray(sid) && sid.length > 0 && sid.every(v => typeof v === 'string'));
    if (!ok) {
      emit('BLOCK', where, 0, 'Config field "sentinelId" must be a string or a non-empty array of strings');
      config.sentinelId = null;
    }
  }
}

// Поля, которые задают СТРОГОСТЬ проверки. Проверяемая задача не вправе назначать их
// себе: подложив в свой каталог конфиг с чужим sentinelId, она принимала бы собственный
// выдуманный sentinel и проходила гейт. Правила задаёт проект, а не объект проверки.
const AUTHORITATIVE_KEYS = ['profile', 'sentinelId', 'phases'];

function readConfigFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readTextFile(file));
  } catch (error) {
    emit('BLOCK', file, 0, `Cannot parse config: ${error.message}`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    emit('BLOCK', file, 0, 'Config must be a JSON object');
    return null;
  }
  return parsed;
}

function loadConfig(taskDir, explicitPath) {
  // Явно переданный путь считаем доверенным: его указывает тот, кто запускает проверку.
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      emit('BLOCK', explicitPath, 0, `Config not found: ${explicitPath}`);
      return { ...DEFAULT_CONFIG };
    }
    const parsed = readConfigFile(explicitPath);
    if (!parsed) return { ...DEFAULT_CONFIG, _broken: true };
    const merged = { ...DEFAULT_CONFIG, ...parsed, _source: explicitPath };
    validateConfigSchema(merged, explicitPath);
    return merged;
  }

  const projectPath = path.join(process.cwd(), 'v8std.config.json');
  const taskPath = path.join(taskDir, 'v8std.config.json');
  const sameFile = path.resolve(projectPath) === path.resolve(taskPath);

  let config = { ...DEFAULT_CONFIG };
  let source = null;

  if (fs.existsSync(projectPath)) {
    const parsed = readConfigFile(projectPath);
    if (!parsed) return { ...DEFAULT_CONFIG, _broken: true };
    config = { ...config, ...parsed };
    source = projectPath;
  }

  if (!sameFile && fs.existsSync(taskPath)) {
    const parsed = readConfigFile(taskPath);
    if (!parsed) return { ...DEFAULT_CONFIG, _broken: true };
    if (source) {
      // Проектный конфиг уже задал строгость: из локального берём только раскладку.
      const rejected = AUTHORITATIVE_KEYS.filter(k => k in parsed);
      if (rejected.length > 0) {
        emit('WARN', taskPath, 0, `Task-local config cannot override ${rejected.join(', ')} — project config wins`);
      }
      for (const key of Object.keys(parsed)) {
        if (!AUTHORITATIVE_KEYS.includes(key)) config[key] = parsed[key];
      }
    } else {
      // Проектного конфига нет — локальный используется целиком (автономный запуск).
      config = { ...config, ...parsed };
      source = taskPath;
    }
  }

  config._source = source;
  if (source) validateConfigSchema(config, source);
  return config;
}

// --- разрешение путей: ЕДИНСТВЕННЫЙ источник раскладки ----------------------
// Все обходы файлов идут через этот helper. Если появится второй способ искать
// evidence-файлы, промоут-гейт снова начнёт молча отключаться на чужой раскладке.

// Поддерживает `**/`, `**`, `*`, `?`. Промежуточные плейсхолдеры нужны, чтобы раскрытие
// `**` не попало под последующее правило для одиночной `*`.
const GLOBSTAR_SLASH = '\u0000';
const GLOBSTAR = '\u0001';

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(GLOBSTAR_SLASH).join('(?:.*/)?')
    .split(GLOBSTAR).join('.*');
  return new RegExp(`^${escaped}$`);
}

// Каталоги, которые не содержат отметок и не должны сканироваться.
const SKIP_DIRS = new Set(['node_modules', '.git', 'secrets']);

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // Недоступный каталог — не повод падать с необработанным исключением: процесс
      // завершился бы кодом 1, который вызывающая сборка прочитает как «предупреждения».
      // Пропуск обязан быть заметным, поэтому WARN, а не тишина.
      emit('WARN', current, 0, `Cannot read directory, skipped: ${error.code || error.message}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function resolveEvidenceFiles(taskDir, config) {
  const all = walkFiles(taskDir);
  // Без конфига ограничиваемся markdown — разумный дефолт. Но если globs заданы явно,
  // фильтр по расширению применять НЕЛЬЗЯ: конфиг вида `**/task-log.txt` иначе молча
  // не находил бы ничего, и пользователь получал бы «чисто» на ненайденных записях.
  if (!config.evidenceGlobs || config.evidenceGlobs.length === 0) {
    return all.filter(f => f.toLowerCase().endsWith('.md'));
  }
  const matchers = config.evidenceGlobs.map(globToRegExp);
  return all.filter(file => {
    const rel = path.relative(taskDir, file).split(path.sep).join('/');
    return matchers.some(re => re.test(rel));
  });
}

function resolvePromoteReport(taskDir, config) {
  const target = path.resolve(taskDir, config.promoteReport || DEFAULT_CONFIG.promoteReport);
  const root = path.resolve(taskDir);
  // Отчёт обязан лежать внутри проверяемого каталога: `promoteReport: "../old-report.md"`
  // позволял удовлетворить гейт чужим, давно написанным файлом.
  const inside = target === root || target.startsWith(root + path.sep);
  return { path: target, inside };
}

// --- парсер evidence-строки -------------------------------------------------

// Вырезает запись из строки с учётом вложенных списков: закрывающей считается скобка,
// парная открывающей `[v8std`, а не первая встречная (иначе `ids_checked=[a,b]` рвёт запись).
function extractRecordSpan(line) {
  const start = line.search(/\[v8std\s+\w+:/);
  if (start < 0) return null;
  let depth = 0;
  let inQuote = null;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) { if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return line.slice(start, i + 1);
    }
  }
  return null; // скобка не закрыта — запись повреждена
}

function parseEvidenceLine(line) {
  // Запись ищем в любом месте строки, а не только в её конце: на практике её часто
  // оформляют пунктом списка и дополняют пояснением — `- \`[v8std applied: …]\` — почему`.
  // Содержимое записи от этого не меняется, поэтому отвергать такую строку значит
  // объявлять нарушением читаемое оформление. Защита от невидимого malformed сохраняется:
  // если корректную запись извлечь не удалось, строка с маркером всё равно даёт BLOCK.
  const span = extractRecordSpan(line);
  if (!span) return null;
  const m = span.match(/^\[v8std\s+(\w+):\s*([\s\S]*)\]$/);
  if (!m) return null;
  const type = m[1];
  const body = m[2];
  const fields = {};
  // разбор верхнего уровня по запятым, с учётом [..] и кавычек
  let depth = 0;
  let inQuote = null;
  let escape = false;
  let current = '';
  const tokens = [];
  for (const ch of body) {
    if (escape) { current += ch; escape = false; continue; }
    if (ch === '\\' && inQuote) { current += ch; escape = true; continue; }
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { tokens.push(current); current = ''; }
    else current += ch;
  }
  if (current) tokens.push(current);
  const duplicates = [];
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq < 0) continue;
    const key = token.slice(0, eq).trim();
    let value = token.slice(eq + 1).trim();
    const list = value.match(/^\[(.*)\]$/);
    if (list) {
      value = list[1].split(',').map(s => s.trim()).filter(Boolean);
    } else {
      const quoted = value.match(/^["'](.*)["']$/);
      if (quoted) value = quoted[1];
    }
    // Повтор ключа — не опечатка, а способ переопределить проверку: при
    // `status=not_found, status=found` побеждало последнее значение и запись проходила.
    if (key in fields) duplicates.push(key);
    fields[key] = value;
  }
  return { type, fields, raw: line, duplicates };
}

function validateIdList(idList, file, lineNo, fieldName, config) {
  // Скаляр вместо списка уже отклонён проверкой типов; молча выходить здесь нельзя —
  // иначе `ids_checked=NOT_AN_ID` осталось бы вовсе непроверенным.
  if (!Array.isArray(idList)) return;
  // В gate нераспознанный идентификатор — блокирующая ошибка: запись со списком вида
  // `["std450,std603"]` формально непуста, но не содержит ни одного проверяемого ID,
  // то есть проверка не подтверждена. В lint это остаётся предупреждением.
  const severity = config && config.profile === 'gate' ? 'BLOCK' : 'WARN';
  for (const id of idList) {
    if (!STD_ID_RE.test(id)) {
      emit(severity, file, lineNo, `Suspicious ID "${id}" in ${fieldName} (expected stdNNN / acc:NNN / bslls:Code / v8cs:code / patterns:alias)`);
    }
  }
}

// Ожидаемый ТИП каждого поля. Без явной схемы `ids_checked="[]"` (строка, похожая на
// список) и `ids_checked=NOT_AN_ID` (скаляр вместо списка) проскакивали мимо обеих
// проверок: одна ждала массив, другая — строку, и каждая считала это заботой другой.
const FIELD_TYPES = {
  applied: { phase: 'scalar', scope: 'scalar', ids_checked: 'list', conclusion: 'scalar' },
  skipped: { phase: 'scalar', scope: 'scalar', planned_ids: 'list', reason: 'scalar', retries: 'scalar' },
  discovered: { phase: 'scalar', scope: 'scalar', query: 'scalar', top_ids: 'list', new_ids: 'list', decision: 'scalar' },
  sentinel: { id: 'scalar', status: 'scalar', phase: 'scalar' },
};

// Списки, которые обязаны быть непустыми: «проверил ничего» и «искал ничего» — не проверка.
// `new_ids` намеренно не здесь: пустой результат discovery законен.
const NON_EMPTY_LISTS = {
  applied: ['ids_checked'],
  skipped: ['planned_ids'],
  discovered: ['top_ids'],
  sentinel: [],
};

// Невидимые символы (zero-width, BOM, неразрывные пробелы) — та же пустота, только
// незаметная глазу и проходящая обычный trim().
const INVISIBLE_RE = /[\u00A0\u180E\u200B-\u200F\u202F\u205F\u2060\u3000\uFEFF]/g;

function isBlank(value) {
  return String(value).replace(INVISIBLE_RE, '').trim().length === 0;
}

function validateRecord(record, file, lineNo, config) {
  const { type, fields } = record;
  if (!RECORD_TYPES.has(type)) {
    emit('BLOCK', file, lineNo, `Unknown record type "${type}"`);
    return;
  }
  for (const key of new Set(record.duplicates || [])) {
    emit('BLOCK', file, lineNo, `Duplicate field "${key}" — a repeated key silently overrides the earlier value`);
  }
  for (const required of REQUIRED_KEYS[type]) {
    if (!(required in fields)) {
      emit('BLOCK', file, lineNo, `Missing required field "${required}" for type "${type}"`);
      continue;
    }
    const value = fields[required];
    const expected = FIELD_TYPES[type][required];

    // 1. Тип — до всего остального.
    if (expected === 'list' && !Array.isArray(value)) {
      emit('BLOCK', file, lineNo, `Field "${required}" must be a list like [stdA,stdB], got scalar "${value}"`);
      continue;
    }
    if (expected === 'scalar' && Array.isArray(value)) {
      emit('BLOCK', file, lineNo, `Field "${required}" must be a scalar value, got list`);
      continue;
    }

    // 2. Пустота — включая невидимые символы.
    if (expected === 'scalar' && isBlank(value)) {
      emit('BLOCK', file, lineNo, `Empty value for required field "${required}" in type "${type}"`);
      continue;
    }
    if (expected === 'list') {
      const meaningful = value.filter(v => !isBlank(v));
      if (meaningful.length === 0 && NON_EMPTY_LISTS[type].includes(required)) {
        emit('BLOCK', file, lineNo, `Empty list "${required}" in type "${type}" — an empty check is not a check`);
      }
    }
  }
  if (fields.phase !== undefined) {
    const phase = String(fields.phase).trim();
    if (phase.length === 0) {
      emit('WARN', file, lineNo, 'Empty phase');
    } else if (Array.isArray(config.phases) && config.phases.length > 0 && !config.phases.includes(phase)) {
      emit('WARN', file, lineNo, `Unknown phase "${phase}" (configured: ${config.phases.join(', ')})`);
    }
  }
  if (fields.scope !== undefined && !SCOPE_RE.test(String(fields.scope))) {
    emit('WARN', file, lineNo, `Scope "${fields.scope}" is not kebab-case`);
  }
  if (type === 'skipped') {
    if (fields.reason && !ALLOWED_REASON.has(fields.reason)) {
      emit('WARN', file, lineNo, `Unknown reason "${fields.reason}" (allowed: ${[...ALLOWED_REASON].join(', ')})`);
    }
    if (fields.retries && fields.retries !== '3') {
      emit('WARN', file, lineNo, `retries="${fields.retries}" — anti-pattern, allowed retries=3`);
    }
    validateIdList(fields.planned_ids, file, lineNo, 'planned_ids', config);
  }
  if (type === 'discovered') {
    if (fields.decision && !ALLOWED_DECISION.has(fields.decision)) {
      emit('BLOCK', file, lineNo, `Unknown decision "${fields.decision}" (allowed: ${[...ALLOWED_DECISION].join(', ')})`);
    }
    validateIdList(fields.top_ids, file, lineNo, 'top_ids', config);
    validateIdList(fields.new_ids, file, lineNo, 'new_ids', config);
  }
  if (type === 'applied') {
    if (fields.conclusion && !CONCLUSION_RE.test(fields.conclusion)) {
      emit('BLOCK', file, lineNo, `Bad conclusion "${fields.conclusion}" (expected: clean | violation:<stdNNN|acc:NNN|bslls:Code|v8cs:code|patterns:alias>)`);
    }
    validateIdList(fields.ids_checked, file, lineNo, 'ids_checked', config);
  }
  if (type === 'sentinel') {
    if (fields.status !== undefined && !ALLOWED_STATUS.has(fields.status)) {
      emit('BLOCK', file, lineNo, `Unknown status "${fields.status}" (allowed: ${[...ALLOWED_STATUS].join(', ')})`);
    }
    if (fields.id !== undefined && !STD_ID_RE.test(String(fields.id))) {
      emit('BLOCK', file, lineNo, `Sentinel id "${fields.id}" is not a valid identifier`);
    }
    // Сверяем ВСЕГДА, когда sentinelId настроен, — включая пустой или отсутствующий id.
    // Иначе пустое значение молча обходило бы весь третий слой.
    const allowed = sentinelIds(config);
    if (allowed.length > 0 && !allowed.includes(String(fields.id ?? ''))) {
      emit('BLOCK', file, lineNo, `Sentinel id "${fields.id ?? ''}" is not among configured sentinelId [${allowed.join(', ')}] — a drifting sentinel detects nothing`);
    } else if (config.profile === 'gate' && allowed.length > 1 && String(fields.id ?? '') !== allowed[0]) {
      // Только в строгом режиме: завершённые задачи с прежним эталоном не должны
      // становиться «грязными» на обычном прогоне.
      emit('WARN', file, lineNo, `Sentinel id "${fields.id}" is a legacy value; new work must use "${allowed[0]}"`);
    }
  }
}

// --- сбор записей -----------------------------------------------------------

// Вырезает содержимое HTML-комментариев, оставляя только видимый текст строки.
// Комментарий закрывается первым `-->` (CommonMark, вложенности нет).
function maskComments(line, inComment) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (inComment) {
      const close = line.indexOf('-->', i);
      if (close < 0) return { visible: out, inComment: true };
      i = close + 3;
      inComment = false;
      continue;
    }
    const open = line.indexOf('<!--', i);
    if (open < 0) { out += line.slice(i); break; }
    out += line.slice(i, open);
    i = open + 4;
    inComment = true;
  }
  return { visible: out, inComment };
}

function collectRecords(taskDir, config) {
  const collected = []; // {record, file, line}
  for (const file of resolveEvidenceFiles(taskDir, config)) {
    // BOM обязателен к удалению: в Windows-редакторах он появляется сам собой, а с ним
    // первая строка файла перестаёт совпадать с заголовком секции — и весь файл молча
    // считается пустым.
    const lines = readTextFile(file).replace(/^﻿/, '').split(/\r?\n/);
    let inSection = false;
    let sectionLevel = 2;
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let inComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Различаем данные и иллюстрацию данных по положению ЗАГОЛОВКА секции, а не по
      // наличию ограждения:
      //   • заголовок внутри ``` — это пример в документации, записи под ним не считаются
      //     (иначе пакет, положенный в проверяемое дерево, вечно удовлетворял бы гейт);
      //   • заголовок снаружи — секция настоящая, и записи в ней считаются даже если
      //     оформлены код-блоком (агенты часто так делают ради читаемости).
      // Длина ограждения значима: по CommonMark закрыть блок может только ограждение
      // не короче открывающего. Без учёта длины ```` закрывалось ``` — и остаток
      // документации ошибочно становился «данными».
      // Комментарии вырезаем ПЕРВЫМ делом и работаем дальше только с видимым текстом.
      // Прежняя схема решала «пропустить строку или нет», а затем отдавала парсеру строку
      // целиком — и он брал первую запись, которая лежала внутри комментария. Достаточно
      // было приписать к закомментированной записи любой внешний маркер, чтобы выключенная
      // запись засчиталась как настоящая.
      const masked = maskComments(line, inComment);
      inComment = masked.inComment;
      const visible = masked.visible;
      if (visible.trim().length === 0) continue;

      // Различаем данные и иллюстрацию данных по положению ЗАГОЛОВКА секции, а не по
      // наличию ограждения:
      //   • заголовок внутри ``` — это пример в документации, записи под ним не считаются;
      //   • заголовок снаружи — секция настоящая, и записи в ней считаются даже если
      //     оформлены код-блоком (агенты часто так делают ради читаемости).
      // Длина ограждения значима: по CommonMark закрыть блок может только ограждение
      // не короче открывающего.
      const fence = visible.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        const marker = fence[1];
        if (!inFence) {
          inFence = true; fenceChar = marker[0]; fenceLen = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
          inFence = false; fenceChar = ''; fenceLen = 0;
        }
        continue;
      }

      // Заголовок распознаётся ТОЛЬКО целиком: `## v8std evidence example` — это раздел
      // документации про формат, а не секция с данными.
      const heading = inFence ? null : visible.match(SECTION_HEADING_RE);
      if (heading) { inSection = true; sectionLevel = heading[1].length; continue; }
      // Секцию закрывает заголовок того же или более высокого уровня: секция уровня 3
      // не должна обрываться вложенным в неё заголовком уровня 4.
      if (!inFence && inSection) {
        const other = visible.match(/^(#{1,6})\s+\S/);
        if (other && other[1].length <= sectionLevel) inSection = false;
      }
      // ...включая setext-форму: текст, подчёркнутый === или ---. Без этого записи
      // из следующего раздела продолжали считаться принадлежащими evidence-секции.
      if (!inFence && inSection && visible.trim() && !visible.trim().startsWith('|')) {
        const next = lines[i + 1];
        if (next !== undefined && /^\s{0,3}(=+|-{2,})\s*$/.test(next)) { inSection = false; }
      }
      if (!inSection) continue;
      // Любое упоминание маркера в активной секции — заявка на запись. Узкий шаблон
      // `[v8std <слово>:` пропускал строки без двоеточия и с переносом, то есть
      // нарушение оставалось невидимым.
      if (!visible.includes('[v8std')) continue;
      const record = parseEvidenceLine(visible);
      if (!record) {
        emit('BLOCK', file, i + 1, `Malformed v8std evidence line: ${visible.trim()}`);
        continue;
      }
      collected.push({ record, file, line: i + 1 });
    }
  }
  return collected;
}

// --- промоут-гейт -----------------------------------------------------------
// Секция «discoveries to promote» требуется только при decision=applied|noted.
// `not_relevant` — осознанно отвергнутый стандарт, продвигать нечего.

function validatePromoteSection(taskDir, config, collected) {
  const promotable = new Set();
  for (const { record } of collected) {
    if (record.type !== 'discovered') continue;
    if (!PROMOTABLE_DECISIONS.has(record.fields.decision)) continue;
    if (Array.isArray(record.fields.new_ids)) {
      for (const id of record.fields.new_ids) promotable.add(id);
    }
  }
  if (promotable.size === 0) return;

  const report = resolvePromoteReport(taskDir, config);
  const idList = [...promotable].join(',');
  if (!report.inside) {
    emit('BLOCK', taskDir, 0, `promoteReport "${config.promoteReport}" resolves outside the checked directory — the promote gate must not be satisfied by an external file`);
    return;
  }
  if (!fs.existsSync(report.path)) {
    emit('BLOCK', taskDir, 0, `promotable new_ids present (${idList}) but ${path.basename(report.path)} is missing — § "v8std discoveries to promote" cannot be verified`);
    return;
  }
  const lines = readTextFile(report.path).split(/\r?\n/);
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    // Заголовок целиком: `## v8std discoveries to promote example` — это документация.
    if (/^##\s+v8std discoveries to promote\s*#*\s*$/i.test(lines[i])) { sectionStart = i; break; }
  }
  if (sectionStart < 0) {
    emit('BLOCK', report.path, 0, `promotable new_ids present (${idList}) but § "v8std discoveries to promote" is missing`);
    return;
  }
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+\S/.test(lines[i])) { sectionEnd = i; break; }
  }
  const body = lines.slice(sectionStart + 1, sectionEnd).join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Незакрытый комментарий скрывает остаток секции — иначе достаточно было открыть
    // `<!--` и «упомянуть» под ним нужный ID, не приняв решения на самом деле.
    .replace(/<!--[\s\S]*$/, '')
    .replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1\s*$/gm, '')
    // Аналогично — незакрытое ограждение.
    .replace(/^\s*(`{3,}|~{3,})[\s\S]*$/m, '')
    .trim();
  if (body.length === 0) {
    emit('BLOCK', report.path, sectionStart + 1, `promotable new_ids present (${idList}) but § "v8std discoveries to promote" is empty (only HTML comments / whitespace)`);
    return;
  }
  // Наличие любого текста — не решение по находке. Каждый продвигаемый ID должен быть
  // назван: иначе секция с одним словом «TODO» закрывала гейт.
  for (const id of promotable) {
    const token = new RegExp(`(^|[^\\w:.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w:.-]|$)`);
    if (!token.test(body)) {
      emit('BLOCK', report.path, sectionStart + 1, `promotable id "${id}" is not mentioned in § "v8std discoveries to promote" — the decision on it was never recorded`);
    }
  }
}

// --- gate-профиль: проверка полноты, а не только формата --------------------

function validateGateCompleteness(taskDir, config, collected) {
  if (collected.length === 0) {
    emit('BLOCK', taskDir, 0, 'No v8std evidence records found — in gate profile an empty result is a silent skip, not a clean run. Add at least one [v8std applied|skipped|discovered] record or run with --lint.');
    return;
  }
  const types = new Set(collected.map(c => c.record.type));

  // sentinelId обязателен именно в gate: без него разные sentinel-записи не с чем сверять,
  // и третий слой превращается в декорацию.
  const allowedSentinels = sentinelIds(config);
  if (allowedSentinels.length === 0 || !allowedSentinels.every(v => STD_ID_RE.test(v))) {
    emit('BLOCK', taskDir, 0, `Gate profile requires a valid "sentinelId" in config (got ${JSON.stringify(config.sentinelId ?? null)}) — without it sentinel records cannot be verified.`);
  }

  const sentinels = collected.filter(c => c.record.type === 'sentinel');
  if (sentinels.length === 0) {
    emit('BLOCK', taskDir, 0, 'No [v8std sentinel: ...] record — index staleness was never checked.');
  } else if (allowedSentinels.length > 0) {
    // Совпадающий по id sentinel обязан подтвердить, что индекс жив. `not_found` означает,
    // что источник истины протух: результаты этой сессии недостоверны.
    const matching = sentinels.filter(c => allowedSentinels.includes(String(c.record.fields.id ?? '')));
    const confirmed = matching.filter(c => c.record.fields.status === 'found');
    if (matching.length > 0 && confirmed.length === 0) {
      const anchor = matching[0];
      emit('BLOCK', anchor.file, anchor.line, `Sentinel "${anchor.record.fields.id}" reported status=not_found — the standards index is stale or unavailable, so this run's checks are not trustworthy.`);
    }
  }
  if (!types.has('discovered') && !types.has('skipped')) {
    emit('BLOCK', taskDir, 0, 'No [v8std discovered: ...] and no [v8std skipped: ...] record — proactive discovery was never performed nor explicitly waived.');
  }

  // «Триггеров не нашлось» — это ВЫВОД ПОИСКА, а не право не искать. Контракт требует
  // хотя бы один запрос к сервису даже когда ни одна ситуация не сработала. Без этого
  // правила достаточно одной строки skipped, чтобы пройти гейт, не сделав ничего.
  const waivedOnly = collected.some(c => c.record.type === 'skipped'
    && c.record.fields.reason === 'no_matching_situation');
  if (waivedOnly && !types.has('discovered')) {
    const anchor = collected.find(c => c.record.type === 'skipped'
      && c.record.fields.reason === 'no_matching_situation');
    emit('BLOCK', anchor.file, anchor.line, 'reason=no_matching_situation claims no trigger matched, but there is no [v8std discovered: ...] record proving a search was actually run. Add the discovered record with the query used, or use a reason that reflects a real failure.');
  }
  if (Array.isArray(config.phases) && config.phases.length > 0) {
    const covered = new Set(
      collected
        .filter(c => c.record.type !== 'sentinel')
        .map(c => String(c.record.fields.phase || '').trim())
        .filter(Boolean)
    );
    const missing = config.phases.filter(p => !covered.has(p));
    if (missing.length > 0) {
      emit('WARN', taskDir, 0, `Configured phases without any evidence record: ${missing.join(', ')}`);
    }
  }
}

// --- основной проход --------------------------------------------------------

function validatePack(taskDir, config) {
  if (!fs.existsSync(taskDir)) {
    emit('BLOCK', taskDir, 0, `Directory not found: ${taskDir}`);
    return;
  }
  const collected = collectRecords(taskDir, config);
  for (const { record, file, line } of collected) {
    validateRecord(record, file, line, config);
  }
  validatePromoteSection(taskDir, config, collected);
  if (config.profile === 'gate') {
    validateGateCompleteness(taskDir, config, collected);
  }
}

// --- main -------------------------------------------------------------------

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd !== 'validate-pack') {
    console.error('Usage: v8std-evidence-validator.mjs validate-pack <dir> [--gate|--lint] [--config <path>]');
    process.exit(2);
  }
  const args = [];
  let profileOverride = null;
  let configPath = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--gate') profileOverride = 'gate';
    else if (rest[i] === '--lint') profileOverride = 'lint';
    else if (rest[i] === '--config') configPath = rest[++i];
    else args.push(rest[i]);
  }
  if (!args[0]) {
    console.error('validate-pack requires <dir>');
    process.exit(2);
  }
  const taskDir = args[0];
  const config = loadConfig(taskDir, configPath);
  if (profileOverride) config.profile = profileOverride;
  // Неизвестный профиль НЕ понижается до lint: молчаливое ослабление контроля — это
  // ровно тот отказ, против которого построен инструмент. Схема конфига уже дала BLOCK;
  // здесь только приводим значение к безопасному для дальнейшего прохода.
  if (config.profile !== 'gate' && config.profile !== 'lint') {
    config.profile = 'gate';
  }
  const activeProfile = config.profile;
  validatePack(taskDir, config);

  let block = 0;
  let warn = 0;
  for (const f of findings) {
    console.log(`${f.severity} ${f.file}:${f.line} — ${f.message}`);
    if (f.severity === 'BLOCK') block++;
    else warn++;
  }
  const suffix = `profile=${activeProfile}`;
  if (block > 0) {
    console.log(`v8std-evidence-validator: ${block} BLOCK, ${warn} WARN — strict-fail (${suffix})`);
    process.exit(2);
  }
  if (warn > 0) {
    console.log(`v8std-evidence-validator: 0 BLOCK, ${warn} WARN — soft-warning (${suffix})`);
    process.exit(1);
  }
  console.log(`v8std-evidence-validator: clean (${suffix})`);
  process.exit(0);
}

main();
