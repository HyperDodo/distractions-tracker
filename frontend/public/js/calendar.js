import { Temporal } from '@js-temporal/polyfill';
export function bounds(date, timezone, kind='day') {
 let d=Temporal.PlainDate.from(date); if(kind==='week')d=d.subtract({days:d.dayOfWeek-1});
 const end=d.add({days:kind==='week'?7:1});
 const ms=x=>Number(x.toZonedDateTime({timeZone:timezone,plainTime:'00:00'}).epochMilliseconds);
 return {from:d.toString(),to:end.toString(),start:ms(d),end:ms(end)};
}
export function metrics(entries, notes, b, timezone) {
 const started=entries.filter(e=>e.started_at>=b.start&&e.started_at<b.end);
 const complete=entries.filter(e=>e.ended_at!==null);
 const durations=started.filter(e=>e.ended_at!==null).map(e=>e.ended_at-e.started_at).sort((a,b)=>a-b);
 const total=complete.reduce((sum,e)=>sum+Math.max(0,Math.min(e.ended_at,b.end)-Math.max(e.started_at,b.start)),0);
 const group=(field)=>{const out=Object.create(null); for(const e of entries){const key=e[field]||'Не указано';const v=out[key]??={count:0,duration_ms:0};if(e.started_at>=b.start&&e.started_at<b.end)v.count++;if(e.ended_at!==null)v.duration_ms+=Math.max(0,Math.min(e.ended_at,b.end)-Math.max(e.started_at,b.start));}return out;};
 // Sweep completed intervals, dropping end points at or before each start (half-open intervals).
 const intervals=complete.map(e=>[Math.max(e.started_at,b.start),Math.min(e.ended_at,b.end)]).filter(([a,z])=>a<z).sort((a,z)=>a[0]-z[0]);
 const heap=[];let overlaps=0;
 const pop=()=>{const last=heap.pop();if(heap.length){heap[0]=last;let i=0;while(true){let l=i*2+1,r=l+1,m=i;if(l<heap.length&&heap[l]<heap[m])m=l;if(r<heap.length&&heap[r]<heap[m])m=r;if(m===i)break;[heap[i],heap[m]]=[heap[m],heap[i]];i=m;}}};
 for(const [start,end] of intervals){while(heap.length&&heap[0]<=start)pop();overlaps+=heap.length;heap.push(end);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(heap[p]<=heap[i])break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}}
 const hours=Array(24).fill(0); for(const e of started) hours[Number(Temporal.Instant.fromEpochMilliseconds(e.started_at).toZonedDateTimeISO(timezone).hour)]++;
 return {started_count:started.length,total_duration_ms:total,median_duration_ms:durations.length?(durations[Math.floor((durations.length-1)/2)]+durations[Math.floor(durations.length/2)])/2:null,short_count:durations.filter(x=>x<300000).length,by_source:group('source_name'),by_kind:group('kind'),by_reason:group('involvement_reason'),hours,estimated_count:started.filter(x=>x.estimated).length,missing_source:started.filter(x=>!x.source_name).length,missing_kind:started.filter(x=>!x.kind||x.kind==='unknown').length,overlaps,coverage:notes,active_entry:entries.find(x=>x.ended_at===null)||null};
}
