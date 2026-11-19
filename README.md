# Трекер обращений и отвлечений

Личная PWA для телефона и компьютера. Нажмите «Отвлекли», чтобы запустить таймер, и «Завершить», чтобы сохранить обращение. Прошедшие обращения можно внести вручную. В приложении доступны журнал, статистика за день и неделю, выгрузка JSON/CSV и разбор через языковую модель.

Один Cloudflare Worker обслуживает интерфейс и API, D1 хранит общий журнал, а Cloudflare Access разрешает вход по email владельца. После начальной синхронизации журнал доступен без сети. Приложение хранит изменения на устройстве и передаёт их в D1 после восстановления связи.

## Новая установка на Cloudflare

### 1. Подготовьте исходники

Понадобятся Git, Node.js 24 с npm, Python 3 для тестов и аккаунт Cloudflare с доступом к Workers, D1 и Zero Trust. Для личной установки подходит адрес `workers.dev`. Версия PWA опубликована в ветке `pwa-offline-sync`. После клонирования выполняйте команды в корне проекта.

```sh
git clone --branch pwa-offline-sync https://github.com/HyperDodo/distractions-tracker.git
cd distractions-tracker
npm ci
npm test
npm run check
npx wrangler login
npx wrangler whoami
```

`npm run check` проверяет сборку. `wrangler login` открывает вход в аккаунт Cloudflare для управления установкой. По выводу `whoami` убедитесь, что Wrangler работает с нужным аккаунтом.

### 2. Создайте D1 и примените миграции

```sh
npx wrangler d1 create interruption-tracker
cp wrangler.production.example.jsonc wrangler.production.jsonc
```

Если Wrangler предложит перенести настройки базы в текущий конфигурационный файл, выберите **No**, поскольку рабочий конфиг создаётся из шаблона. В `wrangler.production.jsonc` подставьте UUID из вывода вместо `REPLACE_WITH_D1_DATABASE_ID`. Оставьте привязку `DB` и имя базы `interruption-tracker`. Если выбрали другое имя базы, используйте его в файле и во всех командах D1.

Шаблон ссылается на собранную PWA в `frontend/dist`. Он включает `workers.dev`, отключает адреса отдельных версий через `preview_urls: false` и сохраняет переменные Dashboard при публикации через `keep_vars: true`. Рабочий `wrangler.production.jsonc` хранится локально и исключён из Git. Во всех командах для удалённого Worker и D1 указывайте этот файл явно.

```sh
npx wrangler d1 migrations list interruption-tracker --remote --config wrangler.production.jsonc
npx wrangler d1 migrations apply interruption-tracker --remote --config wrangler.production.jsonc
```

### 3. Опубликуйте Worker с закрытым API

Для первой публикации оставьте `"vars": {}` в рабочем конфиге. На этом этапе используйте пустую базу.

```sh
npm run deploy -- --config wrangler.production.jsonc --dry-run
npm run deploy -- --config wrangler.production.jsonc
```

Вторая команда публикует Worker. Возьмите фактический HTTPS-адрес из вывода Wrangler. Если `workers.dev` настраивается впервые, Cloudflare предложит выбрать поддомен аккаунта.

До настройки Access запрос `GET /api/settings` на этом адресе возвращает **HTTP 503** с кодом `AUTH_CONFIGURATION_ERROR`. Это ожидаемо. Статическая оболочка пока доступна без входа. Переходите к проверке с личными данными после настройки и проверки Access.

### 4. Включите Cloudflare Access

1. Включите Zero Trust для аккаунта и настройте способ входа. Для одного владельца подойдёт одноразовый PIN на email.
2. Откройте **Workers & Pages → ваш Worker → Access → Protect this Worker behind Access**.
3. Выберите **All traffic**. В политике **Allow** укажите точный email владельца через правило **Include → Emails**. Сохраните настройку через **Apply Access**.
4. Если доступна только настройка по домену, создайте в **Zero Trust → Access controls → Applications** приложение типа **Self-hosted**. В поле домена укажите hostname Worker целиком и оставьте путь пустым. Для каждого дополнительного адреса проверьте защиту отдельно.

Скопируйте значения для `vars` из настроек Cloudflare.

| Переменная | Где взять |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | **Zero Trust → Settings → Team name and domain → Team name**. Подставьте имя в `https://<team-name>.cloudflareaccess.com`. |
| `ACCESS_AUD` | **Zero Trust → Access controls → Applications → Edit** для приложения этого Worker. В **Additional settings** скопируйте **Application Audience (AUD) Tag**. |
| `ACCESS_EMAIL` | Тот же email, который указан в политике **Allow** и используется для входа. |

Замените пустой объект `vars` в `wrangler.production.jsonc`. Ниже фрагмент файла с примерами значений.

```json
"vars": {
  "ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
  "ACCESS_AUD": "YOUR_ACCESS_APPLICATION_AUD",
  "ACCESS_EMAIL": "owner@example.com"
}
```

```sh
npm run deploy -- --config wrangler.production.jsonc
```

Вход проверяется Cloudflare Access. При вызове API Worker дополнительно проверяет подпись, срок, издателя, аудиторию и email из JWT. [Настройка Access для Worker](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) · [Где найти AUD](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag)

### 5. Проверьте вход, синхронизацию и установку

1. В приватном окне откройте адрес приложения и `/api/sync?after=0`. Должен появиться вход или отказ в доступе. Проверьте, что email, которого нет в политике, не открывает журнал.
2. Войдите email владельца. В инструментах браузера откройте **Network** и проверьте, что `GET /api/sync?after=0` возвращает HTTP 200 с JSON. Дождитесь завершения начальной синхронизации.
3. Запустите таймер на компьютере. На телефоне войдите под тем же email, дождитесь появления таймера и завершите его. Проверьте на обоих устройствах, что в журнале одна завершённая запись.
4. Установите PWA через меню Chrome на Android или через **Поделиться → На экран «Домой»** в Safari на iPhone. Откройте установленное приложение онлайн, войдите при необходимости и дождитесь синхронизации. Затем отключите сеть, внесите тестовую запись и перезапустите PWA. Убедитесь, что запись сохранилась локально. Включите сеть и проверьте, что запись один раз появилась на втором устройстве.

## Подключение моделей

Модели настраиваются отдельно от облачной синхронизации. Таймер, журнал и числовая статистика работают и без ключей.

### Встроенный OpenRouter

Откройте **Workers & Pages → ваш Worker → Settings → Variables and Secrets → Add** и добавьте обе настройки.

| Имя | Тип | Значение |
| --- | --- | --- |
| `OPENROUTER_DEFAULT_API_KEY` | **Secret** | Рабочий API-ключ OpenRouter. |
| `OPENROUTER_DEFAULT_MODEL` | **Text** | Точный ID модели из каталога OpenRouter. |

Нажмите **Deploy**. Храните оба значения в Cloudflare. Для старого рабочего `wrangler.production.jsonc` добавьте `"keep_vars": true` на верхнем уровне или передавайте `--keep-vars` при публикации. Оставьте настройки модели вне `vars` файла, чтобы менять их через Dashboard. [Каталог моделей](https://openrouter.ai/models) · [Переменные Cloudflare](https://developers.cloudflare.com/workers/configuration/environment-variables/) · [Настройка keep_vars](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)

В приложении откройте **Настройки → Подключение к модели**, выберите **Встроенный OpenRouter** и сохраните. Разбор будет использовать заданную в Cloudflare модель по тарифу OpenRouter. Пока выбрано личное подключение, оно имеет приоритет. Установки со старым `OPENROUTER_FREE_API_KEY` используют `openrouter/free`, пока обе новые настройки отсутствуют.

### OpenRouter, CheapAI или свой провайдер

Для сохранения своих токенов сгенерируйте ключ шифрования командой `openssl rand -base64 32`. Сохраните значение в менеджере секретов и введите его при запросе Wrangler.

```sh
npx wrangler secret put LLM_TOKEN_ENCRYPTION_KEY --config wrangler.production.jsonc
```

Затем в **Настройки → Подключение к модели** выберите провайдера, укажите идентификатор модели и введите API-токен этого провайдера. Для своего OpenAI-совместимого API добавьте публичный HTTPS Base URL до `/chat/completions`. Например, из `https://api.provider.com/v1/chat/completions` берётся `https://api.provider.com/v1`. Нажмите **Сохранить подключение**.

`LLM_TOKEN_ENCRYPTION_KEY` шифрует личный токен на сервере, чтобы подключение работало на обоих устройствах. Сохраняйте прежний ключ шифрования при обновлениях. Если его заменили или потеряли, введите личный токен заново. Команда `secret put` публикует новую версию Worker с заданным секретом. Секреты также можно добавить в **Workers & Pages → ваш Worker → Settings → Variables and Secrets**. [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

После сохранения нажмите **Проверить модель**, затем запустите разбор дня с записями. Проверка отправляет короткий текст без записей. Интерфейс показывает расход токенов и стоимость, если поставщик возвращает эти данные. Разбор передаёт активному провайдеру записи и заметки за период. Расходы определяет провайдер выбранной модели. Вернуться к встроенному подключению можно через настройки.

## Обновление существующей установки

Сохраните текущие Worker, D1, Access-приложение и локальный `wrangler.production.jsonc`. Если обновляетесь со старой версии, сравните рабочий конфиг с шаблоном и перенесите `assets.directory: "./frontend/dist"`, флаг `global_fetch_strictly_public` в `compatibility_flags` и `keep_vars: true`. Сохраните собственные значения `database_id`, `name` и `vars`.

Перед миграцией проверьте релиз на отдельном Worker с тестовой D1 и своей политикой Access. В рабочем аккаунте запишите ID текущей версии и сделайте резервную копию D1. Для каждого обновления выбирайте новое имя файла. Копия содержит личные данные, поэтому храните её в защищённом месте.

```sh
npx wrangler deployments list --config wrangler.production.jsonc
mkdir -p .backups
npx wrangler d1 export interruption-tracker --remote --output .backups/before-update-01.sql --config wrangler.production.jsonc
```

```sh
git pull --ff-only
npm ci
npm test
npm run deploy -- --config wrangler.production.jsonc --dry-run
npx wrangler d1 migrations list interruption-tracker --remote --config wrangler.production.jsonc
npx wrangler d1 migrations apply interruption-tracker --remote --config wrangler.production.jsonc
npm run deploy -- --config wrangler.production.jsonc
```

Wrangler применяет только ожидающие миграции. Проверьте вход, прежний журнал, синхронизацию на двух устройствах и выбранную модель. Если переходите с версии с `LLM_API_KEY`, настройте отдельные новые секреты и заново введите старый личный токен через интерфейс, если хотите сохранить своего провайдера. Сохраните `LLM_API_KEY`, пока возможен откат на использовавшую его версию. После окончания этого периода старый секрет можно удалить.

Для отката укажите ранее записанный ID версии или выберите её в **Workers & Pages → ваш Worker → Deployments**.

```sh
npx wrangler rollback PREVIOUS_VERSION_ID --config wrangler.production.jsonc
```

Откат Worker меняет код и статические файлы. Схема и данные D1 остаются в текущем состоянии. После отката откройте PWA онлайн. Восстановление D1 из копии выполняется отдельно и может потерять более свежие записи. [Управление версиями Worker](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) · [Команды D1](https://developers.cloudflare.com/d1/wrangler-commands/)

## Если что-то не работает

| Симптом | Что проверить |
| --- | --- |
| `503 AUTH_CONFIGURATION_ERROR` | До настройки входа это ожидаемо. После неё проверьте все три `ACCESS_*` в рабочем конфиге и повторите публикацию. |
| `401 AUTH_REQUIRED` после входа | Проверьте домен команды и AUD именно этого Access-приложения. Откройте адрес Worker и войдите заново, если сессия истекла. |
| `403 ACCESS_DENIED` | Сверьте email политики Access, учётную запись при входе и `ACCESS_EMAIL`. |
| `SYNC_UNAVAILABLE` или «Синхронизация временно недоступна» | В Network найдите ответ `/api/sync`. Если Worker отвечает 503, проверьте привязку `DB`, UUID и применение миграций с `--remote` к этой базе. Если запроса или ответа нет, проверьте сеть и вход. Оставьте данные сайта в браузере, пока очередь изменений не отправится. |
| После обновления журнал пуст | Проверьте UUID D1, вход в правильный Worker, выбранную дату и часовой пояс. |
| Встроенный OpenRouter недоступен | Проверьте обе настройки у нужного Worker: секрет `OPENROUTER_DEFAULT_API_KEY` и текстовую переменную `OPENROUTER_DEFAULT_MODEL`. Проверьте выбранный режим и лимит ключа. |
| Свой токен не сохраняется или не читается | Проверьте `LLM_TOKEN_ENCRYPTION_KEY`. При замене этого секрета заново сохраните токен в настройках. |
| Модель отвечает 401 или 429 | 401 у провайдера обычно означает неверный токен. При 429 проверьте лимиты и квоты. Для своего API проверьте также Base URL и идентификатор модели. |
| OpenRouter возвращает HTTP 403, в том числе на `openrouter/free` | Проверьте лимит активного API-ключа, бюджет рабочего пространства и правила доступа в OpenRouter. Когда провайдер сообщает причину в распознаваемом формате, приложение показывает, где искать ограничение. При выборе `openrouter/free` в личном подключении используется сохранённый токен. Встроенное подключение использует ключ Worker. [Ключи OpenRouter](https://openrouter.ai/settings/keys) · [Ошибки OpenRouter](https://openrouter.ai/docs/api/reference/errors-and-debugging) |
| Провайдер вернул перенаправление или некорректный ответ API | Проверьте конечный HTTPS Base URL и поддержку Chat Completions. Адрес должен вести прямо к API, а ответ должен содержать JSON Chat Completions. |

## Локальная разработка

```sh
npm ci
npm run migrate:local
npm test
npm run check
npm run dev
```

`dev`, `test`, `check` и `deploy` собирают PWA в `frontend/dist`. После правок интерфейса в запущенном окружении выполните `npm run build`. Локальная D1 хранится в `.wrangler/`. API по-прежнему требует подписанный JWT Cloudflare Access. Автоматические проверки используют тестовые данные и подпись. Для проверки реального входа и синхронизации используйте отдельный защищённый Worker и тестовую D1.

[Дополнительные настройки домена и автоматической публикации](docs/cloudflare-deployment.md)
