const encoder = new TextEncoder();

async function* rows(db, table, key) {
  let cursor = null;
  for (;;) {
    const result = await db.prepare(`SELECT * FROM ${table} WHERE (? IS NULL OR ${key} > ?) ORDER BY ${key} LIMIT 500`).bind(cursor, cursor).all();
    for (const row of result.results) yield row;
    if (result.results.length < 500) break;
    cursor = result.results.at(-1)[key];
  }
}

function csv(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function stream(iterator) {
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); }
  });
}

async function* jsonExport(db, started, settings) {
  yield JSON.stringify({schema_version: 1, app_version: '0.1.0', export_started_at: started, settings}).slice(0, -1);
  for (const [name, key] of [['entries','id'], ['day_notes','date'], ['reports','id']]) {
    yield `,"${name}":[`;
    let first = true;
    for await (const row of rows(db, name, key)) {
      yield (first ? '' : ',') + JSON.stringify(row);
      first = false;
    }
    yield ']';
  }
  const end = await db.prepare('SELECT data_revision FROM settings WHERE id=1').first();
  yield `,"export_finished_at":${Date.now()},"data_revision_after":${JSON.stringify(end?.data_revision ?? null)},"consistency":"paged; not a point-in-time backup"}`;
}

async function* csvExport(db) {
  const fields = ['id','started_at','ended_at','source_name','kind','note','why_me','capture_mode','time_estimated'];
  yield '\ufeff' + ['ID','Начало UTC мс','Окончание UTC мс','Источник','Тип','Заметка','Почему именно я','Способ записи','Время приблизительное'].map(csv).join(',') + '\r\n';
  for await (const row of rows(db, 'entries', 'id')) yield fields.map(key => csv(row[key])).join(',') + '\r\n';
}

export async function handleExport(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/export' || request.method !== 'GET') return null;
  const format = url.searchParams.get('format');
  if (!['json', 'csv'].includes(format)) return Response.json({error:{code:'INVALID_FORMAT',message:'Выберите JSON или CSV'}}, {status:400, headers:{'Cache-Control':'no-store'}});
  const settings = await env.DB.prepare('SELECT * FROM settings WHERE id=1').first();
  const content = format === 'json' ? jsonExport(env.DB, Date.now(), settings) : csvExport(env.DB);
  return new Response(stream(content), {headers:{'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="interruptions.${format}"`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
}
