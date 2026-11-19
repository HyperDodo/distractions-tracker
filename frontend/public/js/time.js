let anchor = null;
export function calibrate(serverNow, before, after) { if (Number.isFinite(serverNow)) anchor = {server:serverNow + (after-before)/2, mono:performance.now(), skew:serverNow-Date.now()}; }
export function now() { return anchor ? Math.round(anchor.server + performance.now()-anchor.mono) : Date.now(); }
export function clockSkew() { return anchor?.skew || 0; }
export function day(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(timestamp);
  const date = Object.fromEntries(parts.map(part => [part.type,part.value]));
  return `${date.year.padStart(4,'0')}-${date.month}-${date.day}`;
}
export function clock(timestamp, timezone) { return new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}).format(timestamp); }
export function duration(ms) { let n=Math.max(0,Math.floor(ms/1000)); const h=Math.floor(n/3600); n%=3600; return `${h ? h+':' : ''}${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
