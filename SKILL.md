---
name: v8std-standards-harness
description: >
  Use when writing, reviewing, or designing 1C:Enterprise (BSL) code and configuration
  metadata — enforces a fail-closed check against official 1C development standards (v8std)
  instead of relying on the agent to remember them. Triggers on: writing a query, creating
  or changing a metadata object (catalog, document, register, form, role), document posting
  and register movements, export procedures, client-server transitions, privileged mode,
  localization, configuration extensions, and any BSL code review. Produces machine-readable
  evidence lines that a validator can gate on, so a skipped standards check cannot pass
  silently. Not for non-1C codebases.
---

# v8std standards harness

Обвязка вокруг MCP-сервиса стандартов разработки 1С (`https://ai.v8std.ru/mcp`).

Решает одну конкретную проблему: **агент пропускает сверку со стандартами молча**. Он не
врёт и не ошибается — он просто не считает проверку обязательной, а вы узнаёте об этом на
ревью или в проде. Обычная инструкция «сверяйся со стандартами» эту проблему не решает,
потому что её невыполнение ничем не отличается от её выполнения.

## Как это устроено: четыре слоя

Ни один слой не самодостаточен. Работают только вместе.

| Слой | Что ловит | Что протекает без него |
|---|---|---|
| **1. Карта триггеров** | Известные ситуации: «пишешь запрос → std729/437/438» | Агент сверяется по настроению и по памяти |
| **2. Обязательный поиск** | Стандарты вне карты — минимум один `v8std_search` за фазу | Карта замерзает в моменте создания и тихо устаревает |
| **3. Sentinel** | Протухший или недоступный индекс MCP | «Ничего не нашлось» неотличимо от «сервис лежит» |
| **4. Валидатор** | Саму молчаливую деградацию — отсутствие следа проверки | Все три слоя выше — необязательная рекомендация |

Карта — в двух проекциях:
- [`references/standards-map.md`](references/standards-map.md) — по объекту метаданных:
  «создаёшь регистр → …», «настраиваешь RLS → …»;
- [`references/situations.md`](references/situations.md) — по действию в коде:
  «пишешь `ОбработкаПроведения` → …», «составной тип в запросе → …».

Почему именно четыре слоя и какие инциденты их породили —
[`references/field-notes.md`](references/field-notes.md).
Как поставить это у себя — [`references/INSTALL.md`](references/INSTALL.md).

## Слой 1: карта триггеров

1. Определи ситуацию: что ты делаешь с кодом и с какими объектами метаданных.
2. Найди её в одной из двух проекций карты.
3. Прочитай указанные стандарты через MCP: `v8std_get_page("std657")` — **строкой**, не
   числом (`v8std_get_page(657)` вернёт `found=false`).
4. Примени и оставь запись (см. «Формат evidence»).

Уровни: `always` — сверка обязательна всегда при срабатывании триггера; `conditional` —
при наличии подситуации; `optional` — для нестандартных решений.

## Слой 2: proactive discovery

Карта — short-list, а не исчерпывающий чек-лист. Поэтому **минимум один `v8std_search` за
фазу работы**, даже когда карта, кажется, всё покрыла.

1. Возьми `search_queries` своей ситуации из
   [`references/situations.md`](references/situations.md) (раздел «Discovery taxonomy»)
   либо сформулируй свой запрос и обоснуй его в записи.
2. Разбери результаты. ID, которого нет в карте, проверь через `v8std_get_page(<id>)`.
3. Реши: `applied` (применил) / `noted` (учёл на будущее) / `not_relevant` (не подходит).
4. Оставь запись `[v8std discovered: ...]`.

Если ни одна ситуация не сработала — **всё равно** один поиск по теме работы плюс запись
`[v8std skipped: ..., reason=no_matching_situation]`. Молчаливый пропуск запрещён: именно он
и есть тот отказ, против которого построена вся обвязка.

## Слой 3: sentinel

Один раз за задачу проверь заведомо существующий ID: `v8std_get_page("<sentinelId>")`.

- Ожидание — `found=true`, запись `[v8std sentinel: id=<...>, status=found, phase=<...>]`.
- `found=false` или MCP не отвечает после 3 попыток → `[v8std skipped: ...,
  reason=stale_or_unavailable_index]`.

**Sentinel фиксируется при установке** — возьмите самый свежий стандарт, который сегодня
отдаёт MCP, и пропишите его в `sentinelId` конфига. Незафиксированный sentinel бесполезен.

> **Честная граница слоя.** Sentinel ловит недоступность сервиса, исчезновение ID и откат
> индекса назад. Он **не ловит противоположное** — что индекс ушёл вперёд, а ваша карта
> осталась в прошлом. Против этого работает только слой 2 плюс датированная ревизия карты
> (`last_reviewed_at`).

## Слой 4: формат evidence и валидатор

Каждая проверка оставляет **одну строку** в секции `## v8std evidence` вашего рабочего
артефакта (по умолчанию — `v8std-evidence.md` в корне ветки; настраивается).

```
[v8std applied: phase=<фаза>, scope=<ситуация>, ids_checked=[stdA,stdB], conclusion=clean|violation:<id>]
[v8std skipped: phase=<фаза>, scope=<ситуация>, planned_ids=[stdA,stdB], reason=<причина>, retries=3]
[v8std discovered: phase=<фаза>, scope=<ситуация>, query="<запрос>", top_ids=[stdA,stdB], new_ids=[stdB], decision=applied|noted|not_relevant]
[v8std sentinel: id=<stdNNN>, status=found|not_found, phase=<фаза>]
```

| Поле | Допустимые значения |
|------|---------------------|
| `phase` | Любая непустая метка вашего процесса. Если задан `phases` в конфиге — сверяется по нему |
| `scope` | Короткий kebab-case: `document-posting`, `new-common-module`, `query-virtual-table`, `no-matching-situation` |
| ID-поля | `stdNNN` (`std450`), `acc:NNN` (`acc:105`), `bslls:Code` (`bslls:MissingSpace`), `v8cs:code` (`v8cs:module-region-empty`), `patterns:alias` и подстраницы (`patterns:solid:single_responsibility`). Списки не могут быть пустыми — кроме `new_ids`, где пустота законна |
| `reason` | `mcp_unavailable_after_3_retries`, `timeout`, `auth_error`, `parse_error`, `tool_not_found`, `no_matching_situation`, `stale_or_unavailable_index` |
| `decision` | `applied`, `noted`, `not_relevant` |
| `conclusion` | `clean` или `violation:<id>` |
| `status` | `found`, `not_found` |

**Retry-политика:** при недоступности MCP — 3 попытки с задержками 1 с / 3 с / 9 с. Только
после третьей оформляется `skipped`. Меньше трёх — анти-паттерн, валидатор даст WARN.

Запуск валидатора:

```
node tools/v8std-evidence-validator.mjs validate-pack <каталог>          # профиль из конфига
node tools/v8std-evidence-validator.mjs validate-pack <каталог> --gate   # fail-closed
node tools/v8std-evidence-validator.mjs validate-pack <каталог> --lint   # только формат
```

| Профиль | Поведение |
|---|---|
| `lint` | Проверяет формат того, что нашёл. Ноль записей = чисто. Для ручного прогона |
| `gate` | Fail-closed. Требует: настроенный `sentinelId` в конфиге; минимум одну запись; sentinel с этим `id` и `status=found`; discovery или обоснованный skip. **Ноль записей = exit 2.** Для CI и pre-commit |

Оба профиля отвергают записи, которые лишь выглядят заполненными:

- пустые значения обязательных полей (`id=`, `status=`, `query=`) — включая пробелы
  и невидимые символы вроде `U+200B`;
- пустые обязательные списки (`ids_checked=[]`, `top_ids=[]`, `planned_ids=[]`) —
  «проверил ничего» не является проверкой; исключение — `new_ids`, где пустота законна;
- подмену типа: `ids_checked="[]"` (строка вместо списка), `ids_checked=NOT_AN_ID`
  (скаляр вместо списка), `query=[]` (список вместо скаляра).

Профиль `gate` дополнительно блокирует:

- `sentinel` со `status=not_found` — если источник истины протух, результаты всей сессии
  недостоверны;
- нераспознанный идентификатор в списках (в `lint` это остаётся предупреждением);
- повтор ключа в записи (`status=not_found, status=found`) — вторым значением легко
  переопределить проверку;
- запись, оформленную не одной строкой, и любую строку с маркером `[v8std`, которую
  не удалось разобрать: невидимое нарушение опаснее явного.

Записи не засчитываются, если они выключены разметкой: внутри HTML-комментария, внутри
кода-примера в документации (заголовок секции сам стоит в код-блоке) или за пределами
секции — её закрывает следующий заголовок любого из двух верхних уровней.

Коды выхода: `0` — чисто, `1` — только предупреждения, `2` — блокирующие нарушения.

## Что этот скилл не делает

- **Не анализирует код.** v8std — справочник стандартов и диагностик. Он не заменяет
  синтаксическую проверку, статический анализатор и прогон тестов.
- **Не гарантирует, что стандарт применён правильно.** Валидатор проверяет наличие и
  формат следа, а не качество решения. Это защита от пропуска, а не от ошибки.
- **Не обновляет карту сам.** Карта — снимок на дату. Ревизия — ваша ответственность,
  рецепт в [`references/INSTALL.md`](references/INSTALL.md).
