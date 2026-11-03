# 27 rewrite-observability

## Постановка (@NikolayXHD)

Кнопка «rewrite files on disk» в `/template` (пакет `pi-template`) должна
обеспечивать observability. Симптом: `roles/snippets/tests.md.template` не
порождает `tests.md` рядом — наблюдаемого результата записи нет.

## Факты AS-IS и развилки

Сверка с кодом, симптомы и варианты решения — `design.md`. Вопросы интервью и
принятые решения — `interview.md`.

## Статус

- [x] интервью: правило целей для include-источников
- [x] интервью: форма отчёта кнопки
- [x] дизайн (см. `design.md`: способ и проверка)
- [x] реализация в `pi-template` (см. `design.md`: реализация)
- [x] проверка: `node probe.mjs`, live-прогоны, `node live/typecheck.mjs`
- [x] ручной сценарий 13 `TESTING.md` в живой сессии TUI (@NikolayXHD) —
  закрыта по решению @NikolayXHD («закрывай задачи»)

## Закрыта

Перенесена в `done/` по решению @NikolayXHD.
