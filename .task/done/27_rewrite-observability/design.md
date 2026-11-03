# Дизайн 27: наблюдаемость записи целей

Задача: `.task/current/27_rewrite-observability/issue.md`. Код: пакет
`pi-template` (`git/github.com/NikolayXHD/pi-template`).

## Факты AS-IS (сверено с кодом)

1. Набор источников задаёт `discoverSources` (sources.ts): контекстные файлы
   (`CONTEXT_CANDIDATES`), `SYSTEM.md`/`APPEND_SYSTEM.md`, `skills/**`,
   `prompts/**`, `agents/**`, legacy `.agents`, `~/.agents`. Дерево `roles/**`
   в набор не входит: его файлы не являются источниками.
2. Include-резолвер `createPartialResolver` (sources.ts) читает `X.template`
   при наличии, иначе `X`. Цель рядом с include-файлом не создаётся и не
   пишется; README закрепляет это только примером `modes/`: «mode files have
   no target and are never written to».
3. `writeVersion` (session.ts) пишет цели из `ContextVersion.texts` — цели
   источников `discoverSources`, и только их. В агент-директории 15 файлов
   `*.template`: 7 источников (`AGENTS.md.template`,
   `agents/helper-flash-*.md.template`, `prompts/teamlead.md.template`) и 8
   include-файлов (`roles/*.md.template`, `roles/snippets/tests.md.template`),
   у которых цели нет вовсе.
4. Отчёт кнопки: `rewriteFiles` (session.ts) → `performMenuItem` (ui.ts) —
   счётчик «targets rewritten — N file(s)», «targets are current»,
   предупреждение с первой проблемой рендера. Имён файлов в отчёте нет. Ошибка
   записи цели уходит в `warn` (session.ts) — transient-уведомление,
   дедуплицированное по тексту; `sessionWarnings` (session.ts) в UI не
   читается.
5. Материал для подробного отчёта уже собирается: `partialPaths` (session.ts) —
   файлы include последнего рендера, `lastRenderProblems` (session.ts) — сбои
   рендера по файлам.

## Симптомы

- У include-источника нет наблюдаемого результата. Проверить, что попало в
  контекст (например, блок `{{#if is_flash}}` в
  `roles/snippets/tests.md.template`), можно только разбирая цель
  `AGENTS.md.template` — `AGENTS.md`, где include развёрнут внутри чужого
  текста.
- Отчёт кнопки не перечисляет файлы: после нажатия нельзя понять, какие цели
  записаны, какие не изменились, какие пропущены и почему. Симптом задачи —
  «observability нет» — проявляется как молчание о пропущенных файлах.
- Словарь README обещает «a target is the rendered copy `X` next to the
  source» без изъятия; изъятие для include-файлов описано только примером
  `modes/`, обобщённого правила нет. Ментальная модель «у каждого
  `X.template` есть `X`» расходится с поведением.

## Свойства решения

- Правило целей для include-источников должно быть предсказуемым: результат
  не должен зависеть от того, какой include достигнут текущим `view`
  (динамические имена вроде `{{> (concat "roles/" role ".md")}}` зависят от
  значения переменной).
- Цель include-источника по семантике равна вкладу в цель включающего файла:
  тот же рендер под тем же view, вложенные include развёрнуты. Текст с тегами
  в цели не допускается: цель — готовый текст, как у остальных целей.
- Записанная цель не влияет на рендер: резолвер предпочитает `X.template`.
  Цель — наблюдаемый артефакт и кеш последнего успеха, не источник истины.
- Отчёт кнопки обязан называть файлы и причину пропуска; счётчик без имён
  наблюдаемостью не является.

## Развилки

1. Какой `X.template` порождает цель `X` — решено: include, упомянутый в
   шаблонах (интервью, решение 2).
2. Форма отчёта кнопки — решено: уведомление и блок в меню (решение 3).
3. Содержание отчёта — решено: полный список со статусами (решение 4).
4. Git-судьба новых целей — решено: git не трогать (решение 5).

## Способ

1. `sources.ts`: поверх `discoverSources` — сбор include-имён из шаблонов
   (статическое имя; динамическое — для каждого значения из списка значений
   переменной), транзитивно по вложенным include. Результат: набор
   include-источников `{source, target, kind: "include"}` и классификация
   «не включается никуда». Полнота списка `X.template` — обход корней include
   (агент-директория, `<project>/.pi`) с пропуском служебных деревьев
   (`git/`, `npm/`, `sessions/`, `tmp/`, `scratch/`, `intercom/`, `bin/`,
   `install/`, `missions/`, `session-tidy/`, `.task/`, `extensions/`): без
   обхода статус `not included` невозможен.
2. `render-set.ts`: рендер include-источника тем же view, что и цель
   включающего файла; вложенные include развёрнуты. Линт — как у текста
   include (без агентской идентичности, `@` — ошибка).
3. `session.ts`: `writeVersion` пишет цели источников и include-источников и
   возвращает отчёт на файл (`written` / `unchanged` / `failed` с причиной);
   `rewriteFiles` отдаёт отчёт в UI.
4. `ui-model.ts`, `ui.ts`: блок «последняя запись» в меню `/template` со
   списком файлов и статусами; transient-уведомление — сводка (сколько
   записано, сколько без изменений, сколько с ошибками).
5. Документация: `README.md` (правило source/target, цели include-источников,
   отчёт кнопки), `TESTING.md` (сценарий 13 и ручной сценарий observability).

## Проверка

- `node probe.mjs` — сценарий: include-источник порождает цель, отчёт называет
  файл и статус, `not included` виден для неиспользуемого `.template`.
- live-прогоны `live/*.mjs` — без регрессий точек потребления.
- Ручной сценарий `TESTING.md`: при переключении `is_flash`-модели рядом с
  `roles/snippets/tests.md.template` появляется `roles/snippets/tests.md` с
  выбранным вариантом блока, отчёт кнопки перечисляет файлы.

## Реализация (@pi-agent)

Пакет `pi-template`:

- `render.ts` — `collectIncludeNames`: имена include текста (статическое
  имя; динамическое — для каждого значения из списка);
- `sources.ts` — `discoverIncludeSources`: include-источники (`X.template` при
  упоминании имени, транзитивно), кандидаты имён для штампов, `notIncluded`;
  `SourceKind` пополнился `"include"`, `PROJECT_PREFIX` экспортирован;
- `render-set.ts` — `RenderReport.failures`: сбой рендера на файл;
- `session.ts` — include-источники в рендере и записи (`writeVersion`),
  `rewriteFiles()` отдаёт `RewriteReport` со статусом на файл и держит его как
  `lastRewriteReport()`; тексты доставки (`deliveryTexts`) ограничены целями
  источников pi; брекет чтения знает цели include; `/reload` подмешивает текст
  целей include в applied-версию;
- `ui-model.ts` — типы отчёта и подписи (`rewriteSummaryText`,
  `rewriteRowText`);
- `ui.ts` — блок «last rewrite» в меню, сводка в уведомлении и в заголовке
  диалога выбора;
- `live/sdk.mjs`, `live/typecheck.mjs` — поиск SDK pi в managed-установке
  (`PI_MANAGED_INSTALL_ROOT`); раньше — только npm-global, на этой машине
  проверки не запускались;
- `README.md`, `TESTING.md` — правило целей (include-источники), отчёт кнопки,
  номера сценариев.

## Проверка (результат)

- `node probe.mjs` — 124 сценария, `ALL OK`. Новые: обнаружение
  include-источников и `not included`, цель рядом с источником (и
  нетронутый plain include), статусы отчёта на файл, текст отчёта.
- `node live/typecheck.mjs` — `TYPECHECK OK`.
- live-прогоны: `smoke`, `prompt`, `delivery`, `first-run`, `derived`,
  `registration`, `ux` (108 проверок) — без регрессий; в `ux` добавлена
  проверка цели include, сводки уведомления и блока отчёта в меню.
- Живое дерево `~/.pi/agent` (чтение, без записи): include-источники —
  `roles/*.md.template` (7 файлов) и `roles/snippets/tests.md.template`,
  `notIncluded` пуст. Цель `roles/snippets/tests.md` появится при старте
  сессии или по кнопке.

## Побочные эффекты, которые надо учесть

- `findTarget` (session.ts) и лок-протокол `lock.ts` знают только цели
  источников `discoverSources`; цели include-файлов в брекеты чтения не
  попадают. Для файлов, которые pi нативно не читает, это допустимо — но
  решение надо зафиксировать явно.
- Сломанный шаблон не разбирается, его include-имена не собираются: файл,
  упомянутый только им, попадёт в `not included`. Приемлемо — включающий файл
  и так валит рендер.
- README (`README.md`, `pi-template`) и сценарий 13 `TESTING.md` описывают
  кнопку; после правки их содержание должно соответствовать новому правилу.
