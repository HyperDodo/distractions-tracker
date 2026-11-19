import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleExport} from '../backend/export.js';

test('export pages all records and neutralizes spreadsheet formulas', async () => {
  const entries = Array.from({length: 501}, (_, i) => ({id:String(i).padStart(4,'0'), started_at:i, ended_at:i, source_name:i === 0 ? ' =1+1' : 'Источник', note:'тест'}));
  const tables = {entries, day_notes:[], reports:[]};
  const DB = {prepare(sql) { let args; return {bind(...values) {args=values;return this;}, async first() {return sql.startsWith('SELECT data_revision') ? {data_revision:4} : {id:1,timezone:'Europe/Moscow',data_revision:4};}, async all() {const name=sql.match(/FROM (entries|day_notes|reports)/)[1]; return {results:tables[name].filter(row=>args[0] == null || row.id > args[1]).slice(0,500)};}};}};
  const json = await handleExport(new Request('https://example.test/api/export?format=json'),{DB});
  const data = await json.json();
  assert.equal(data.entries.length,501);
  assert.equal(data.settings.timezone,'Europe/Moscow');
  assert.equal(data.entries[0].source_name,' =1+1');
  const csv = await handleExport(new Request('https://example.test/api/export?format=csv'),{DB});
  const text = await csv.text();
  assert.match(text, /"' =1\+1"/);
  assert.equal(text.split('\r\n').length,503);
});
