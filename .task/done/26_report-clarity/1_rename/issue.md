# 1 — Пакет и репозиторий pi-session-tidy

Цель: имя пакета и репозитория называет содержимое — оба способа улучшения
сессии.

Способ: GitHub-репозиторий переименовывает @NikolayXHD — у @pi-agent нет
токена для API. Локальный каталог, `package.json`, идентификаторы расширения,
документация и `settings.json` делает @pi-agent. Прежние имена записей сессии
и конфига читаются как legacy.

Проверка: `node src/probe.mjs` зелёный; расширение грузится в pi; записи
`compact-thinking-applied` старых сессий подхватываются.

## Итог

Сделано @pi-agent: локальный каталог `~/git/pi-session-tidy`, `package.json`,
идентификаторы (`session-tidy-applied`, `session-tidy-rejected`, команда
`/session-tidy`, статус `session-tidy`, конфиг `session-tidy.json`),
документация. Прежние имена записей и конфига читаются как legacy.

Проверено: `node src/probe.mjs` — 78 passed; живая TUI-сессия показывает статус
`💭 0/0 +0` без конфига и не показывает статуса при `enabled: false` в старом
`compact-thinking.json` — legacy-конфиг прочитан.

Осталось за @NikolayXHD: переименовать репозиторий на GitHub до
`pi-session-tidy` — у @pi-agent нет токена для API. После этого @pi-agent
обновляет remote, `settings.json` и переустанавливает пакет.
