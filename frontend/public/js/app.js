import { Temporal } from '@js-temporal/polyfill';
import { request, send } from './api.js';
import { bounds, metrics } from './calendar.js';
import { OfflineStore } from './offline.js';
import { now, day, clock, duration, calibrate, clockSkew } from './time.js';

const app = document.querySelector('#app');
const kinds = ['Согласование', 'Проблема', 'Координация', 'Сделать руками', 'Сам отвлёкся', 'Другое'];
const reasons = ['Нужны мои полномочия', 'У сотрудника нет полномочий', 'Не хватает знаний или опыта', 'Нет назначенного ответственного', 'Решение передали мне', 'Не знаю / другое'];
const sections = [['today', 'Сегодня'], ['history', 'Журнал'], ['analysis', 'Разбор'], ['settings', 'Настройки']];
const providers = [['', 'Встроенный OpenRouter Free'], ['openrouter', 'OpenRouter'], ['cheapai', 'CheapAI'], ['custom', 'Свой провайдер']];
const modelCatalogues = new Map([
  ['openrouter', 'https://openrouter.ai/models'],
  ['cheapai', 'https://cheapai.io/docs?tab=models'],
]);
const metricLabels = {
  started_count: 'началось', total_duration_ms: 'сумма длительностей', median_duration_ms: 'медиана',
  short_count: 'короче пяти минут', estimated_count: 'приблизительных', missing_source: 'без источника',
  missing_kind: 'без типа', overlaps: 'пересечений',
};
const reportLabels = {
  pending: 'Выполняется', completed: 'Готово', failed: 'Ошибка',
  unknown: 'Исход неизвестен', deleted: 'Удалён',
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const ui = {
  section: 'today', date: null, kind: 'day', historyLimit: 100, filters: {},
  modal: null, draftForm: false, message: '', config: null, configError: '', configBusy: false,
  report: null, reportBusy: false,
};
const reportKey = 'interruptions.report';
let model;
let lastServerTime;
let configRequest;
let reportPoll;
let pollingReport = false;
const store = new OfflineStore(receive);

function timezone() {
  return model?.settings?.timezone || 'Europe/Moscow';
}

function todayDate() {
  return day(now(), timezone());
}

function receive(next) {
  const previousTimeZone = model?.settings?.timezone;
  const previousSync = model?.lastSync;
  const changed = !model || next.viewKey !== model.viewKey;
  model = next;
  if (previousSync !== undefined && next.lastSync !== previousSync && next.serverNow
      && next.serverNow !== lastServerTime && Date.now() - next.lastSync < 2000) {
    const sampledAt = performance.now();
    calibrate(next.serverNow, sampledAt, sampledAt);
    lastServerTime = next.serverNow;
  }
  if (next.ready && (!ui.date || (previousTimeZone && previousTimeZone !== timezone()))) ui.date = todayDate();
  if (!changed || ui.modal || ui.draftForm || ui.configBusy || document.activeElement?.matches('input,textarea,select')) {
    updateSyncStatus();
  } else {
    render();
  }
}

function selectedPeriod(kind = 'day') {
  const range = bounds(ui.date, timezone(), kind);
  const entries = model.entries.filter(entry =>
    (entry.started_at < range.end && (entry.ended_at === null || entry.ended_at > range.start))
    || (entry.started_at >= range.start && entry.started_at < range.end && entry.started_at === entry.ended_at),
  );
  const notes = model.notes.filter(note => note.date >= range.from && note.date < range.to);
  return { range, entries, notes };
}

function activeEntry() {
  return model.active;
}

function entryList(entries) {
  if (!entries.length) return '<p class="muted">Нет записей</p>';
  return entries.map(entry => `<button class="entry" type="button" data-edit="${escape(entry.id)}">
    <span><strong>${escape(entry.source_name || 'Не указано')}</strong>
    <small>${escape(entry.kind === 'unknown' ? 'Тип не указан' : entry.kind || 'Тип не указан')}${entry.note ? ' · ' + escape(entry.note) : ''}</small></span>
    <span>${clock(entry.started_at, timezone())} · ${entry.ended_at === null ? 'идёт' : duration(entry.ended_at - entry.started_at)}</span>
  </button>`).join('');
}

function timer() {
  const entry = activeEntry();
  if (!entry) {
    const pins = model.settings.pinned_actions || [];
    return `<div class="card hero"><h1>Что происходит сейчас?</h1>
      <div class="row"><button class="primary big" id="start">Отвлекли</button>
      <button class="secondary" id="manual">Записать прошедшее</button></div>
      ${pins.length ? `<div class="chips entry-actions">${pins.map((pin, i) =>
        `<button class="chip" data-pinned="${i}">${escape(pin.label)}</button>`).join('')}</div>` : ''}
    </div>`;
  }
  const warn = now() - entry.started_at >= 7200000 || day(entry.started_at, timezone()) !== todayDate();
  return `<div class="card hero"><p class="muted">Сейчас идёт</p>
    <h1 class="timer" data-timer="${entry.started_at}">${duration(now() - entry.started_at)}</h1>
    <p class="muted">Началось в ${clock(entry.started_at, timezone())} · ${escape(entry.source_name || 'Источник не указан')}</p>
    ${warn ? '<p class="warning">Ещё идёт? Таймер не остановится автоматически.</p>' : ''}
    <div class="row"><button class="primary" id="finish">Завершить</button>
      <button class="secondary" id="switch">Завершить и начать новое</button></div>
    <div class="chips entry-actions">${kinds.map(kind =>
      `<button class="chip" data-kind="${escape(kind)}" aria-pressed="${entry.kind === kind}">${escape(kind)}</button>`).join('')}</div>
    <button class="secondary" id="details">Добавить детали</button>
  </div>`;
}

function dateInput() {
  return `<input type="date" id="date" aria-label="Дата" value="${escape(ui.date)}">`;
}

function stat(label, value) {
  return `<div class="stat"><strong>${escape(value)}</strong><span>${label}</span></div>`;
}

function today() {
  const { range, entries, notes } = selectedPeriod();
  const totals = metrics(entries, notes, range, timezone());
  return `${timer()}<div class="row section-title"><h2>За выбранный день</h2>${dateInput()}</div>
    <div class="card"><div class="stats">${stat('началось', totals.started_count)}
    ${stat('сумма длительностей', duration(totals.total_duration_ms))}</div>${entryList(entries)}</div>
    <button class="secondary" id="daynote">Контекст дня</button>`;
}

function options(values, selected, empty = 'Не указано') {
  return `<option value="">${empty}</option>${values.map(value =>
    `<option value="${escape(value)}" ${selected === value ? 'selected' : ''}>${escape(value)}</option>`).join('')}`;
}

function history() {
  const { entries } = selectedPeriod();
  const { source, kind, query } = ui.filters;
  const matching = entries.filter(entry =>
    (!source || entry.source_name === source) && (!kind || entry.kind === kind)
    && (!query || entry.note?.toLowerCase().includes(query)),
  );
  return `<h1>Журнал</h1><form class="card" id="filters"><div class="form-grid">
      <label class="field">Дата${dateInput()}</label>
      <label class="field">Источник<input name="source" value="${escape(source)}"></label>
      <label class="field">Тип<select name="kind">${options(kinds, kind, 'Все')}</select></label>
      <label class="field">Поиск по заметке<input name="query" value="${escape(ui.filters.queryText)}"></label>
    </div><div class="row"><button class="secondary">Применить</button>
    <button type="button" class="secondary" id="manual">Записать прошедшее</button></div></form>
    <div class="card">${entryList(matching.slice(0, ui.historyLimit))}
    ${matching.length > ui.historyLimit ? '<button class="secondary" id="more">Загрузить ещё</button>' : ''}</div>`;
}

function reportContent(report) {
  let result = report.result;
  if (!result && report.result_json) {
    try { result = JSON.parse(report.result_json); } catch { result = report.result_json; }
  }
  if (typeof result === 'string') return `<p>${escape(result)}</p>`;
  if (!result) return '';
  const observations = Array.isArray(result.observations) ? result.observations : [];
  const details = [
    ['Почему потребовалось участие', result.necessary_participation],
    ['Гипотезы', result.hypotheses], ['Ограничения', result.limitations], ['Эксперимент', result.experiment],
  ];
  return `<p>${escape(result.summary)}</p>${observations.length ? `<ul>${observations.map(item =>
    `<li>${escape(item?.text)}</li>`).join('')}</ul>` : ''}
    ${details.filter(([, text]) => text).map(([title, text]) =>
      `<p><strong>${title}</strong><br>${escape(text)}</p>`).join('')}`;
}

function reportError(code) {
  if (/^PROVIDER_HTTP_3\d\d$/.test(code || '')) code = 'PROVIDER_REDIRECT';
  return ({
    PROVIDER_HTTP_401: 'Провайдер отклонил токен.',
    PROVIDER_HTTP_403: 'Провайдер отказал в доступе (HTTP 403). Проверьте права и лимиты API-ключа.',
    PROVIDER_HTTP_429: 'Провайдер ограничил запросы. Попробуйте позже.',
    OPENROUTER_403_KEY_LIMIT: 'Исчерпан лимит API-ключа OpenRouter. Проверьте бюджет ключа в OpenRouter.',
    OPENROUTER_403_WORKSPACE_BUDGET: 'Исчерпан бюджет рабочего пространства OpenRouter. Проверьте его лимиты.',
    OPENROUTER_403_GUARDRAIL_BUDGET: 'Исчерпан бюджет правила OpenRouter. Проверьте лимит в разделе Guardrails.',
    OPENROUTER_403_BUDGET: 'OpenRouter сообщил об исчерпанном бюджете. Проверьте лимиты ключа и рабочего пространства.',
    OPENROUTER_403_PERMISSION: 'OpenRouter ограничил доступ для этого запроса. Проверьте права ключа и разрешённые модели.',
    OPENROUTER_403_SAFETY: 'OpenRouter или поставщик модели заблокировал запрос правилом безопасности. Проверьте политики в OpenRouter.',
    OPENROUTER_403_REGION: 'OpenRouter ограничил доступ для региона или IP сервера, который отправил запрос.',
    TIMEOUT: 'Провайдер не ответил вовремя.',
    PROVIDER_UNREACHABLE: 'Не удалось связаться с провайдером.',
    PROVIDER_REDIRECT: 'Провайдер вернул перенаправление. Проверьте адрес API.',
    INVALID_PROVIDER_RESPONSE: 'Провайдер вернул некорректный ответ API.',
    PROVIDER_ERROR: 'Провайдер сообщил об ошибке обработки запроса.',
    INVALID_MODEL_JSON: 'Модель вернула ответ в другом формате.',
    INVALID_MODEL_RESULT: 'Ответ модели не прошёл проверку.',
  })[code] || (code ? 'Проверьте подключение и ID модели в настройках.' : '');
}

function probeUsage(report) {
  if (!report) return '';
  const details = [];
  for (const [key, label] of [['input_tokens', 'Входные токены'], ['output_tokens', 'Выходные токены']]) {
    const count = report[key];
    if (Number.isInteger(count) && count >= 0) details.push(`${label} ${count.toLocaleString('ru-RU')}`);
  }
  if (report.provider === 'openrouter' && Number.isFinite(report.cost) && report.cost >= 0) {
    details.push(`Стоимость ${report.cost.toLocaleString('ru-RU', { maximumSignificantDigits: 6 })} кредитов OpenRouter`);
  }
  return details.length ? `${details.join(' · ')}.` : '';
}

function reportConnectionHint() {
  if (!navigator.onLine || model?.error?.status === 0) return 'Для нового разбора нужен интернет.';
  if (model?.error?.status === 401) return 'Войдите, чтобы запустить разбор.';
  if (model?.error) return model.error.message;
  if (ui.configError && !ui.config) return ui.configError;
  if (!ui.config) return 'Проверяем подключение к модели…';
  if (ui.config.provider) return 'Личное подключение. Применяется тариф выбранного провайдера.';
  if (ui.config.free_available) return 'Встроенный OpenRouter Free.';
  return 'Подключение можно настроить в настройках.';
}

function reportAvailable() {
  return navigator.onLine && !model?.error && !ui.reportBusy && ui.report?.status !== 'pending'
    && Boolean(ui.config?.has_token || ui.config?.free_available);
}

function updateAnalysisControls() {
  const hint = document.getElementById('report-provider-hint');
  const button = document.getElementById('analyze');
  if (hint) hint.textContent = reportConnectionHint();
  if (button) button.disabled = !reportAvailable();
}

function analysis() {
  const { range, entries, notes } = selectedPeriod(ui.kind);
  const totals = metrics(entries, notes, range, timezone());
  const reports = model.reports.filter(report =>
    report.status === 'completed' && report.kind === ui.kind && report.date_from === range.from,
  ).sort((a, b) => b.created_at - a.created_at);
  const reportStatus = ui.report && `<p class="muted notice">${escape(reportLabels[ui.report.status] || ui.report.status || '')}
    ${escape(reportError(ui.report.error_code))}
    ${ui.report.status === 'unknown' ? 'Запрос мог быть обработан провайдером.' : ''}</p>`;
  return `<h1>Разбор</h1><div class="card">
    <div class="row"><select id="report-kind" aria-label="Период">
      <option value="day" ${ui.kind === 'day' ? 'selected' : ''}>День</option>
      <option value="week" ${ui.kind === 'week' ? 'selected' : ''}>Неделя</option>
    </select>${dateInput()}</div>
    <div class="stats entry-actions">${Object.entries(metricLabels).filter(([key]) => typeof totals[key] === 'number').map(([key, label]) =>
      stat(label, key.endsWith('_ms') ? duration(totals[key]) : totals[key])).join('')}</div>
    <p class="muted entry-actions" id="report-provider-hint">${escape(reportConnectionHint())}</p>
    <button class="primary" id="analyze" ${reportAvailable() ? '' : 'disabled'}>Разобрать</button>
    ${reportStatus || ''}</div>
    <div class="card"><h2>Отчёты</h2>${reports.length ? reports.map(report =>
      `<article class="report"><strong>${escape(report.model)}</strong>${reportContent(report)}</article>`).join('') :
      '<p class="muted">Отчётов пока нет</p>'}</div>`;
}

function providerSettings() {
  const config = ui.config;
  if (!config) {
    return `<div class="card"><h2>Подключение к модели</h2><p class="muted">${escape(ui.configError || 'Загружаем настройки подключения…')}</p>
      <button class="secondary" id="reload-provider">Обновить</button></div>`;
  }
  return `<form class="card" id="provider-form" autocomplete="off">
    <h2>Подключение к модели</h2>
    <label class="field">Провайдер<select name="provider">${providers.map(([value, name]) =>
      `<option value="${value}" ${(config.provider || '') === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <div id="personal-provider" ${config.provider ? '' : 'hidden'}>
      <label class="field" id="base-url-field" ${config.provider === 'custom' ? '' : 'hidden'}>Base URL
        <input type="url" name="base_url" placeholder="https://example.com/v1" value="${escape(config.provider === 'custom' ? config.base_url : '')}" ${config.provider === 'custom' ? 'required' : ''}></label>
      <label class="field">ID модели<input name="model" aria-describedby="model-help" value="${escape(config.model)}" ${config.provider ? 'required' : ''}></label>
      <p class="muted" id="model-help">Скопируйте точный ID модели из каталога провайдера.
        <a id="model-catalog" target="_blank" rel="noopener noreferrer" hidden>Открыть каталог моделей</a></p>
      <label class="field">Токен<input type="password" name="token" autocomplete="new-password" spellcheck="false"></label>
      <p class="muted" id="token-status">${config.has_token ? 'Токен сохранён. Оставьте поле пустым, чтобы сохранить его для этого провайдера.' : 'Введите токен своего провайдера.'}</p>
    </div>
    <p class="muted" id="free-provider" ${config.provider ? 'hidden' : ''}>${config.free_available ?
      'Разбор использует бесплатные модели OpenRouter.' : 'Встроенный ключ ещё не настроен.'}</p>
    <div class="row"><button class="primary" ${ui.configBusy ? 'disabled' : ''}>Сохранить подключение</button>
      <button class="secondary" type="button" id="test-model" ${ui.configBusy || (!config.has_token && !config.free_available) ? 'disabled' : ''}>Проверить модель</button></div>
    <p id="provider-message" class="notice" aria-live="polite">${escape(ui.configError)}</p>
  </form>`;
}

function settings() {
  const values = model.settings;
  const pins = (values.pinned_actions || []).map(pin => [pin.label, pin.source_name || '', pin.kind || ''].join(' | ')).join('\n');
  return `<h1>Настройки</h1>
    <form class="card" id="settings-form">
      <label class="field">Часовой пояс<input name="timezone" value="${escape(values.timezone)}" required></label>
      <label class="field">Закреплённые действия <small>По одному на строке: подпись | источник | тип</small>
        <textarea name="pinned_actions_text">${escape(pins)}</textarea></label>
      <label class="field">Рабочая роль<textarea name="analysis_context" maxlength="2000">${escape(values.analysis_context)}</textarea></label>
      <button class="primary">Сохранить настройки</button>
    </form>${providerSettings()}
    <div class="card"><h2>Выгрузка</h2><div class="row">
      <a class="secondary" href="/api/export?format=json">Скачать JSON</a>
      <a class="secondary" href="/api/export?format=csv">Скачать CSV</a></div></div>`;
}

function inputTime(timestamp, zone = timezone()) {
  return Temporal.Instant.fromEpochMilliseconds(timestamp).toZonedDateTimeISO(zone)
    .toPlainDateTime().toString({ smallestUnit: 'minute' });
}

function parseTime(value, zone = timezone()) {
  return Number(Temporal.PlainDateTime.from(value).toZonedDateTime(zone, {
    disambiguation: 'reject',
  }).epochMilliseconds);
}

function entryForm() {
  const { entry, type, zone } = ui.modal;
  const manual = type === 'manual';
  const editTimes = manual || entry?.ended_at != null;
  let defaultEnd = now();
  if (manual && ui.date !== todayDate()) {
    defaultEnd = Number(Temporal.PlainDate.from(ui.date).toZonedDateTime({ timeZone: zone, plainTime: '12:00' }).epochMilliseconds);
  }
  const start = entry?.started_at ?? defaultEnd - 300000;
  const end = entry?.ended_at ?? defaultEnd;
  const recentSources = [...new Set(model.entries.map(item => item.source_name).filter(Boolean))].slice(0, 8);
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <form class="modal-card" id="entry-form"><div class="row">
      <h2 id="modal-title">${manual ? 'Прошедшее обращение' : 'Детали обращения'}</h2>
      <button type="button" class="secondary" id="close">Закрыть</button>
    </div><div class="form-grid">
      ${editTimes ? `<label class="field">Начало<input type="datetime-local" name="started_at" value="${inputTime(start, zone)}" required></label>
      <label class="field">Окончание<input type="datetime-local" name="ended_at" value="${inputTime(end, zone)}" required></label>
      <label class="field">Длительность, минут<input type="number" min="0" max="10080" name="minutes" value="${Math.round((end - start) / 60000)}"></label>
      <label class="field">Считать от<select name="anchor"><option value="end">окончания</option><option value="start">начала</option></select></label>
      <div class="chips">${[2, 5, 10, 15, 30].map(n =>
        `<button type="button" class="chip" data-minutes="${n}">${n} мин</button>`).join('')}</div>
      <p class="muted">Часовой пояс ${escape(zone)}</p>` : ''}
      <label class="field">Источник<input name="source_name" list="recent-sources" maxlength="80" value="${escape(entry?.source_name)}"></label>
      <datalist id="recent-sources">${recentSources.map(value => `<option value="${escape(value)}"></option>`).join('')}</datalist>
      <label class="field">Тип<select name="kind">${options(kinds, entry?.kind)}</select></label>
      <label class="field">Почему именно я<select name="involvement_reason">${options(reasons, entry?.involvement_reason)}</select></label>
    </div><label class="field">Заметка<textarea name="note" maxlength="500">${escape(entry?.note)}</textarea></label>
    ${manual ? '<label><input type="checkbox" name="estimated" checked> Время приблизительное</label>' : ''}
    <div class="row"><button class="primary">Сохранить</button>
      ${entry ? '<button type="button" class="danger" id="delete-entry">Удалить</button>' : ''}</div>
    <p class="warning notice" id="form-error" role="alert"></p></form></div>`;
}

function dayNoteForm() {
  const note = ui.modal.note || {};
  const range = bounds(ui.modal.date, ui.modal.zone);
  const maxMinutes = (range.end - range.start) / 60000;
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <form class="modal-card" id="daynote-form"><h2 id="modal-title">Контекст дня</h2>
    <div class="form-grid">
      <label class="field">План на свои задачи, минут<input name="planned_minutes" type="number" min="0" max="${maxMinutes}" value="${escape(note.planned_minutes)}"></label>
      <label class="field">Было доступно, минут<input name="available_minutes" type="number" min="0" max="${maxMinutes}" value="${escape(note.available_minutes)}"></label>
      <label class="field">Полнота журнала<select name="coverage">
        <option value="unknown">Не оценивал</option>
        <option value="partial" ${note.coverage === 'partial' ? 'selected' : ''}>Записал часть</option>
        <option value="full" ${note.coverage === 'full' ? 'selected' : ''}>Внёс всё, что помню</option>
      </select></label></div>
    <label class="field">Что получилось<textarea name="outcomes_note" maxlength="2000">${escape(note.outcomes_note)}</textarea></label>
    <div class="row"><button class="primary">Сохранить</button>
      <button type="button" class="secondary" id="close">Отмена</button></div>
    <p class="warning notice" id="form-error" role="alert"></p></form></div>`;
}

function describeVersion(kind, value) {
  if (!value) return '<p class="muted">Запись отсутствует или удалена.</p>';
  if (kind === 'entry') {
    return `<p><strong>${escape(value.source_name || 'Источник не указан')}</strong><br>
      ${Number.isFinite(value.started_at) ? escape(inputTime(value.started_at).replace('T', ' ')) : ''}
      ${value.ended_at === null ? ' · таймер идёт' : Number.isFinite(value.ended_at) ?
        ' — ' + escape(inputTime(value.ended_at).replace('T', ' ')) : ''}</p>
      <p>${escape([value.kind === 'unknown' ? '' : value.kind, value.involvement_reason, value.note].filter(Boolean).join(' · '))}</p>`;
  }
  if (kind === 'day_note') {
    return `<p>План ${escape(value.planned_minutes ?? '—')} мин · Доступно ${escape(value.available_minutes ?? '—')} мин</p>
      <p>${escape(value.outcomes_note)}</p>`;
  }
  return `<p>${escape(value.timezone)}</p><p>${escape(value.analysis_context)}</p>
    <p>${escape((value.pinned_actions || []).map(pin => pin.label).join(' · '))}</p>`;
}

function conflictNotice(conflict) {
  const { operation, changes, error } = conflict;
  const { type, payload } = operation;
  const kind = type.split('.')[0];
  const key = payload.id || payload.expected_id || payload.date || '1';
  const local = kind === 'entry' ? model.entries.find(entry => entry.id === key) :
    kind === 'day_note' ? model.notes.find(note => note.date === key) : model.settings;
  const remote = error.code === 'ACTIVE_ENTRY_EXISTS'
    ? changes.find(change => change.kind === 'entry' && change.id !== key && change.value?.ended_at === null)
    : changes.find(change => change.kind === kind && change.id === key);
  return `<div class="card warning"><h2>Нужно решить конфликт</h2><p>${escape(error.message)}</p>
    <div class="grid conflict-versions"><div><h3>На этом устройстве</h3>
      ${type === 'entry.delete' ? '<p>Удаление записи</p>' : describeVersion(kind, local || payload)}</div>
      <div><h3>В облаке</h3>${describeVersion(kind, remote?.value)}</div></div>
    <div class="row">
      <button type="button" class="secondary" data-resolution="remote">Оставить облачную версию</button>
      ${conflict.canUseLocal ? '<button type="button" class="primary" data-resolution="local">Сохранить мою версию</button>' : ''}
      ${conflict.canSaveClosed ? '<button type="button" class="primary" data-resolution="closed">Сохранить мой таймер как завершённый</button>' : ''}
    </div></div>`;
}

function syncStatus() {
  const error = model?.error;
  if (error?.code === 'AUTH_CONFIGURATION_ERROR') return 'Требуется настройка входа';
  if (error?.status === 401) return 'Нужно войти';
  if (error?.status === 403) return 'Доступ запрещён';
  if (error && error.status !== 0) return 'Синхронизация недоступна';
  if (error?.status === 0 || !navigator.onLine) return model?.pending ? `Без сети · в очереди ${model.pending}` : 'Без сети';
  if (!model?.ready) return 'Первая синхронизация';
  if (model.conflict) return 'Синхронизация ждёт решения';
  if (model.pending) return `На устройстве · в очереди ${model.pending}`;
  return model.syncing ? 'Синхронизация…' : 'Синхронизировано';
}

function syncNotice() {
  const error = model?.error;
  const retry = '<button class="secondary" id="sync-retry">Повторить</button>';
  const setup = error?.code === 'AUTH_CONFIGURATION_ERROR';
  const login = error?.status === 401;
  const denied = error?.status === 403;
  const statusMessage = setup ? `${escape(error.message)} Владелец приложения должен настроить Cloudflare Access. ${retry}` :
    login ? `Войдите, чтобы синхронизировать журнал. ${model.ready ? 'Записи на устройстве сохранены. ' : ''}<a href="/">Войти</a>` :
    denied ? 'Доступ к журналу для этого аккаунта запрещён. Используйте разрешённый email.' :
    error && error.status !== 0 ? `${escape(error.message)} ${retry}` : '';
  return `${statusMessage ? `<div class="card warning" role="alert">${statusMessage}</div>` : ''}
    ${model?.conflict ? conflictNotice(model.conflict) : ''}
    ${model?.ready && Math.abs(clockSkew()) >= 60000 ? '<div class="card warning">Часы устройства заметно отличаются от серверных.</div>' : ''}`;
}

function legacyNotice() {
  const drafts = store.legacyDrafts();
  if (!drafts.length) return '';
  return `<div class="card"><h2>Черновики из прежней версии</h2>
    ${drafts.map(({ key, draft }) => `<div class="row"><span>${escape(draft.fields?.source_name || draft.entry?.source_name || 'Обращение')}
      ${Number.isFinite(draft.started_at ?? draft.entry?.started_at) ?
        ' · ' + escape(inputTime(draft.started_at ?? draft.entry.started_at).replace('T', ' ')) : ''}</span>
      <button class="secondary" data-legacy="${escape(key)}">Восстановить</button></div>`).join('')}</div>`;
}

function on(id, event, listener) {
  document.getElementById(id)?.addEventListener(event, listener);
}

function onClick(id, listener) {
  on(id, 'click', listener);
}

function showError(error, elementId) {
  const specific = elementId && document.getElementById(elementId);
  if (specific) {
    specific.textContent = error.message;
  } else {
    ui.message = error.message;
    render();
  }
}

function openModal(type, fields = {}) {
  ui.modal = { type, zone: timezone(), ...fields };
  render();
  document.querySelector('.modal input:not([type=checkbox]), .modal textarea')?.focus();
}

function updateSyncStatus() {
  updateAnalysisControls();
  const status = document.getElementById('sync-status');
  const notice = document.getElementById('sync-notice');
  const bootstrap = document.getElementById('sync-bootstrap');
  if (bootstrap) bootstrap.hidden = Boolean(model?.error && model.error.status !== 0);
  if (status) {
    const text = syncStatus();
    if (status.textContent !== text) status.textContent = text;
    status.dataset.waiting = String(Boolean(model?.pending || model?.error || model?.conflict));
  }
  if (notice) {
    const html = syncNotice();
    if (notice.dataset.current === html) return;
    notice.dataset.current = html;
    notice.innerHTML = html;
    onClick('sync-retry', () => { void store.sync(); });
    notice.querySelectorAll('[data-resolution]').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await store.resolve(button.dataset.resolution, { ended_at: now() });
          render();
        } catch (error) {
          showError(error);
        }
      };
    });
  }
}

function render() {
  const status = `<div class="status" id="sync-status" role="status">${escape(syncStatus())}</div>`;
  const header = `<header class="topbar"><strong>Трекер обращений</strong>${status}</header>`;
  const message = ui.message && `<div class="card warning" role="alert">${escape(ui.message)}</div>`;
  if (!model?.ready) {
    app.innerHTML = `${header}<main><div id="sync-notice"></div>${message || ''}
      <div class="card" id="sync-bootstrap"><h1>Первая синхронизация</h1>
      <p>Для первой синхронизации нужен интернет и вход в приложение.</p>
      <button class="secondary" id="first-sync">Повторить</button></div></main>`;
    onClick('first-sync', () => { void store.sync(); });
    updateSyncStatus();
    return;
  }
  const nav = `<nav class="nav" aria-label="Разделы">${sections.map(([id, label]) =>
    `<button data-section="${id}" ${ui.section === id ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
  const content = ({ today, history, analysis, settings })[ui.section]();
  const modal = ui.modal ? (ui.modal.type === 'daynote' ? dayNoteForm() : entryForm()) : '';
  app.innerHTML = `${header}${nav}<main><div id="sync-notice"></div>${message || ''}
    ${legacyNotice()}${content}</main>${modal}`;
  updateSyncStatus();
  bind();
}

async function enqueue(type, payload, errorElement) {
  try {
    ui.message = '';
    await store.enqueue(type, payload);
    ui.modal = null;
    ui.draftForm = false;
    render();
  } catch (error) {
    showError(error, errorElement);
  }
}

function submitEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const { entry, zone } = ui.modal;
  const values = new FormData(form);
  const payload = {
    source_name: values.get('source_name').trim() || null,
    kind: values.get('kind') || null,
    involvement_reason: values.get('involvement_reason') || null,
    note: values.get('note').trim() || null,
  };
  if (form.elements.started_at) {
    const { started_at, ended_at } = form.elements;
    try {
      const start = entry && started_at.value === started_at.defaultValue ? entry.started_at : parseTime(started_at.value, zone);
      const end = entry && ended_at.value === ended_at.defaultValue ? entry.ended_at : parseTime(ended_at.value, zone);
      if (end < start || end > now()) throw new Error('Некорректный интервал.');
      if (!entry || start !== entry.started_at) payload.started_at = start;
      if (!entry || end !== entry.ended_at) payload.ended_at = end;
    } catch {
      document.getElementById('form-error').textContent = 'Проверьте начало и окончание. Время должно существовать в выбранном часовом поясе, а окончание не может быть раньше начала или в будущем.';
      return;
    }
  }
  if (entry) {
    void enqueue('entry.update', { id: entry.id, expected_revision: entry.revision, ...payload }, 'form-error');
  } else {
    void enqueue('entry.create', { id: crypto.randomUUID(), mode: 'manual', estimated: values.has('estimated'), ...payload }, 'form-error');
  }
}

function bindEntryForm() {
  const form = document.getElementById('entry-form');
  if (!form) return;
  form.onsubmit = submitEntry;
  onClick('delete-entry', () => {
    const entry = ui.modal.entry;
    if (confirm('Удалить это обращение?')) {
      void enqueue('entry.delete', { id: entry.id, expected_revision: entry.revision }, 'form-error');
    }
  });
  const { started_at: start, ended_at: end, minutes, anchor } = form.elements;
  if (!start) return;
  const { zone } = ui.modal;
  function shift(number) {
    if (!Number.isFinite(number)) return;
    try {
      if (anchor.value === 'end') start.value = inputTime(parseTime(end.value, zone) - number * 60000, zone);
      else end.value = inputTime(parseTime(start.value, zone) + number * 60000, zone);
      minutes.value = number;
    } catch { /* Invalid local time is reported when the form is submitted. */ }
  }
  function updateMinutes() {
    try { minutes.value = Math.round((parseTime(end.value, zone) - parseTime(start.value, zone)) / 60000); }
    catch { minutes.value = ''; }
  }
  start.onchange = () => { anchor.value = 'start'; updateMinutes(); };
  end.onchange = () => { anchor.value = 'end'; updateMinutes(); };
  minutes.oninput = () => { if (minutes.value !== '') shift(Number(minutes.value)); };
  form.querySelectorAll('[data-minutes]').forEach(button => {
    button.onclick = () => shift(Number(button.dataset.minutes));
  });
}

function bindGeneralSettings() {
  const form = document.getElementById('settings-form');
  if (!form) return;
  const expectedRevision = model.settings.revision;
  form.oninput = () => { ui.draftForm = true; };
  form.onsubmit = event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    const timezone = fields.timezone.trim();
    try { day(now(), timezone); bounds('2026-01-01', timezone); }
    catch { alert('Укажите корректный часовой пояс, например Europe/Moscow.'); return; }
    const pinned = fields.pinned_actions_text.split('\n').map(value => value.trim()).filter(Boolean).map(value => {
      const [label, source_name, kind] = value.split('|').map(part => part.trim());
      return { label, source_name: source_name || null, kind: kind || null };
    });
    if (pinned.length > 50 || pinned.some(pin =>
      !pin.label || pin.label.length > 80 || pin.source_name?.length > 80 || (pin.kind && !kinds.includes(pin.kind)),
    )) {
      alert('Проверьте быстрые действия. Допустимо до 50 действий, подпись и источник до 80 символов, тип из списка приложения.');
      return;
    }
    void enqueue('settings.patch', {
      expected_revision: expectedRevision, timezone, pinned_actions: pinned, analysis_context: fields.analysis_context,
    });
  };
}

function updateProviderFields(form) {
  const provider = form.elements.provider.value;
  const custom = provider === 'custom';
  const changed = provider && (provider !== ui.config.provider ||
    (custom && form.elements.base_url.value.replace(/\/$/, '') !== ui.config.base_url));
  document.getElementById('personal-provider').hidden = !provider;
  document.getElementById('free-provider').hidden = !!provider;
  document.getElementById('base-url-field').hidden = !custom;
  form.elements.base_url.required = custom;
  form.elements.base_url.disabled = !custom;
  form.elements.model.required = !!provider;
  form.elements.token.required = Boolean(provider && (changed || !ui.config.has_token));
  const catalogue = form.querySelector('#model-catalog');
  const catalogueUrl = modelCatalogues.get(provider);
  catalogue.hidden = !catalogueUrl;
  if (catalogueUrl) catalogue.href = catalogueUrl;
  else catalogue.removeAttribute('href');
  document.getElementById('test-model').disabled = ui.draftForm || (!ui.config.has_token && !ui.config.free_available);
}

async function loadProvider() {
  if (configRequest || ui.configBusy) return configRequest;
  configRequest = (async () => {
    try {
      ui.config = await request('/api/llm/config');
      ui.configError = '';
    } catch (error) {
      ui.configError = error.message;
    } finally {
      configRequest = null;
      if (ui.section === 'settings' && !ui.draftForm && !ui.modal) render();
      else if (ui.section === 'analysis') updateAnalysisControls();
    }
  })();
  return configRequest;
}

async function saveProvider(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const provider = fields.get('provider');
  const body = provider ? {
    provider, model: fields.get('model').trim(),
    ...(provider === 'custom' ? { base_url: fields.get('base_url').trim() } : {}),
    ...(fields.get('token').trim() ? { token: fields.get('token').trim() } : {}),
  } : {};
  ui.configBusy = true;
  form.querySelector('button[type=submit], button.primary').disabled = true;
  try {
    ui.config = await send('/api/llm/config', provider ? 'PUT' : 'DELETE', body);
    form.elements.token.value = '';
    ui.configError = 'Подключение сохранено.';
    ui.draftForm = false;
  } catch (error) {
    ui.configError = error.message;
    const message = form.querySelector('#provider-message');
    message.textContent = ui.configError;
  } finally {
    ui.configBusy = false;
    if (!ui.draftForm) render();
    else form.querySelector('button[type=submit], button.primary').disabled = false;
  }
}

function bindProvider() {
  const form = document.getElementById('provider-form');
  if (!form) return;
  updateProviderFields(form);
  form.oninput = event => {
    ui.draftForm = true;
    if (event.target.name === 'provider') form.elements.token.value = '';
    updateProviderFields(form);
  };
  form.onsubmit = saveProvider;
  onClick('test-model', async () => {
    if (ui.config.provider && !confirm('Проверка отправит тестовый запрос по тарифу провайдера. Продолжить?')) return;
    const button = document.getElementById('test-model');
    button.disabled = true;
    try {
      const data = await send('/api/llm/test', 'POST', { report_id: crypto.randomUUID() });
      const report = data.report;
      const message = report?.status === 'completed' ? 'Подключение работает.' :
        reportError(report?.error_code) || 'Проверка пока не завершилась.';
      ui.configError = [message, probeUsage(report)].filter(Boolean).join(' ');
    } catch (error) {
      ui.configError = error.message;
    }
    if (ui.section === 'settings' && !ui.draftForm) render();
    else if (button.isConnected) button.disabled = false;
  });
}

function bind() {
  document.querySelectorAll('[data-section]').forEach(button => {
    button.onclick = () => {
      ui.section = button.dataset.section;
      ui.modal = null;
      ui.draftForm = false;
      ui.message = '';
      render();
      if (['settings', 'analysis'].includes(ui.section)) void loadProvider();
      if (ui.section === 'analysis') void pollReport();
    };
  });
  on('date', 'change', event => {
    if (event.target.value && ui.section !== 'history') {
      ui.date = event.target.value;
      render();
    }
  });
  on('filters', 'input', () => { ui.draftForm = true; });
  on('filters', 'submit', event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    ui.date = document.getElementById('date').value || ui.date;
    ui.filters = { source: fields.source.trim(), kind: fields.kind, queryText: fields.query, query: fields.query.trim().toLowerCase() };
    ui.historyLimit = 100;
    ui.draftForm = false;
    render();
  });
  onClick('more', () => { ui.historyLimit += 100; render(); });
  onClick('manual', () => openModal('manual'));
  onClick('details', () => { const entry = activeEntry(); if (entry) openModal('edit', { entry }); });
  onClick('daynote', () => openModal('daynote', { date: ui.date, note: model.notes.find(note => note.date === ui.date) }));
  onClick('close', () => { ui.modal = null; render(); });
  const start = (preset = {}) => {
    if (!activeEntry()) void enqueue('entry.create', { id: crypto.randomUUID(), mode: 'timer', started_at: now(), ...preset });
  };
  onClick('start', () => start());
  document.querySelectorAll('[data-pinned]').forEach(button => {
    button.onclick = () => {
      const pin = model.settings.pinned_actions[Number(button.dataset.pinned)];
      if (pin) start({ source_name: pin.source_name, kind: pin.kind });
    };
  });
  onClick('finish', () => {
    const entry = activeEntry();
    if (entry) void enqueue('entry.finish', { id: entry.id, expected_revision: entry.revision, clicked_ended_at: now() });
  });
  onClick('switch', () => {
    const entry = activeEntry();
    if (entry) void enqueue('entry.switch', {
      expected_id: entry.id, expected_revision: entry.revision, new_entry_id: crypto.randomUUID(), switch_at: now(),
    });
  });
  document.querySelectorAll('[data-kind]').forEach(button => {
    button.onclick = () => {
      const entry = activeEntry();
      if (entry) void enqueue('entry.update', { id: entry.id, expected_revision: entry.revision, kind: button.dataset.kind });
    };
  });
  document.querySelectorAll('[data-edit]').forEach(button => {
    button.onclick = () => {
      const entry = model.entries.find(item => item.id === button.dataset.edit);
      if (entry) openModal('edit', { entry });
    };
  });
  document.querySelectorAll('[data-legacy]').forEach(button => {
    button.onclick = async () => {
      if (!confirm('Восстановить черновик и синхронизировать его с журналом?')) return;
      try { await store.restoreDraft(button.dataset.legacy); render(); }
      catch (error) { showError(error); }
    };
  });
  on('daynote-form', 'submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    for (const key of ['planned_minutes', 'available_minutes']) values[key] = values[key] === '' ? null : Number(values[key]);
    void enqueue('day_note.put', { date: ui.modal.date, expected_revision: ui.modal.note?.revision || 0, ...values }, 'form-error');
  });
  on('report-kind', 'change', event => { ui.kind = event.target.value; render(); });
  onClick('analyze', () => { void runReport(); });
  onClick('reload-provider', () => { void loadProvider(); });
  bindEntryForm();
  bindGeneralSettings();
  bindProvider();
}

function savedReport() {
  try { return JSON.parse(sessionStorage.getItem(reportKey)); }
  catch { return null; }
}

function rememberReport(id) {
  try { sessionStorage.setItem(reportKey, JSON.stringify({ id })); }
  catch { /* History remains available in IndexedDB after synchronization. */ }
}

function acceptReport(report) {
  ui.report = report;
  clearTimeout(reportPoll);
  if (report.status === 'pending' || report.status === 'unknown' && !report.error_code) {
    reportPoll = setTimeout(pollReport, 2000);
  }
  if (report.status === 'completed') void store.sync();
  if (ui.section === 'analysis' && !ui.modal) render();
}

async function pollReport() {
  const saved = savedReport();
  if (!saved?.id || pollingReport || !navigator.onLine || document.visibilityState !== 'visible') return;
  pollingReport = true;
  try {
    const response = await request(`/api/reports/${encodeURIComponent(saved.id)}`);
    if (response.report) acceptReport(response.report);
  } catch (error) {
    if (error.status === 404 || error.status === 410) {
      try { sessionStorage.removeItem(reportKey); } catch { /* Storage may be unavailable. */ }
    }
  } finally {
    pollingReport = false;
  }
}

async function runReport() {
  if (!reportAvailable()) return;
  if (!confirm('Запустить разбор? С личным подключением применяется тариф поставщика.')) return;
  const { kind, date } = ui;
  ui.reportBusy = true;
  ui.message = '';
  render();
  let id;
  try {
    if (!await store.sync()) throw new Error('Сначала завершите синхронизацию журнала.');
    id = crypto.randomUUID();
    rememberReport(id);
    const response = await send('/api/reports', 'POST', {
      report_id: id, kind, date, timezone: timezone(),
    });
    if (response.report) acceptReport(response.report);
  } catch (error) {
    if (id && (error.status === 0 || error.status >= 500)) acceptReport({ status: 'unknown' });
    showError(error);
  } finally {
    ui.reportBusy = false;
    if (ui.section === 'analysis' && !ui.modal) render();
  }
}

function refreshVisible() {
  if (document.visibilityState !== 'visible') return;
  void store.sync();
  if (['settings', 'analysis'].includes(ui.section) && !ui.draftForm) void loadProvider();
  void pollReport();
}

async function init() {
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      ui.message = 'Не удалось подготовить приложение к открытию без сети.';
      if (!ui.modal && !ui.draftForm) render();
    });
  }
  try {
    await store.open();
    refreshVisible();
  } catch (error) {
    showError(new Error(`Не удалось открыть локальный журнал. ${error.message}`));
  }
}

window.addEventListener('online', refreshVisible);
window.addEventListener('offline', () => {
  updateSyncStatus();
  if (!ui.modal && !ui.draftForm) render();
});
document.addEventListener('visibilitychange', refreshVisible);
setInterval(() => {
  document.querySelectorAll('[data-timer]').forEach(element => {
    element.textContent = duration(now() - Number(element.dataset.timer));
  });
}, 1000);
setInterval(() => {
  if (document.visibilityState === 'visible' && navigator.onLine) void store.sync();
}, 15000);

void init();
