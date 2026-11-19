# Дополнительная настройка Cloudflare

Первая установка, обновление, откат и подключение моделей описаны в [README](../README.md). Здесь собраны дополнительные настройки для собственного домена и CI.

## Собственный домен

Добавьте **Custom Domain** в настройках Worker. При защите Worker через **Access → All traffic** проверьте вход на новом домене и на всех прежних адресах. Если Access настроен по домену, защитите каждый оставленный адрес отдельной записью приложения.

Чтобы отключить старый адрес `workers.dev`, укажите `workers_dev: false` в рабочем `wrangler.production.jsonc` и опубликуйте новую версию. Для адресов отдельных версий сохраните `preview_urls: false`. Другие тестовые окружения настраивайте со своей базой и политикой доступа. [Маршрутизация Workers](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) · [Адреса отдельных версий](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)

## Сборка и публикация из GitHub

По умолчанию отправка коммита в GitHub только обновляет исходники. Для публикации выполните `npm run deploy -- --config wrangler.production.jsonc`. Для автоматической публикации можно подключить **Workers Builds** к ветке с версией PWA.

- В рабочем окружении CI подготовьте конфиг для целевого Worker и D1. Локальный `wrangler.production.jsonc`, исключённый из Git, сам в CI не попадёт.
- Используйте Node.js 24, Python 3, `npm ci` и `npm test`. Для публикации вызывайте `npm run deploy` с явным `--config`, чтобы команда собрала PWA.
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` и `ACCESS_EMAIL` храните в `vars` рабочего конфига. При управлении этими переменными из Dashboard включите `keep_vars: true`.
- `OPENROUTER_FREE_API_KEY` и `LLM_TOKEN_ENCRYPTION_KEY` храните как Worker Secrets в нужном окружении.
- Для миграций D1 используйте отдельный шаг после резервного копирования. У тестовых веток должны быть отдельные Worker, D1 и политика Access. [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
