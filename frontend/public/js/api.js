export class ApiError extends Error {
  constructor(status, payload) { super(payload?.error?.message || (status === 401 ? 'Необходимо восстановить вход' : status === 403 ? 'Доступ запрещён' : `Ошибка сервера (${status})`)); this.status = status; this.payload = payload; }
}
export async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, {cache:'no-store', redirect:'manual', ...options, headers:{...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}}); }
  catch { throw new ApiError(0, {error:{message:'Не удалось связаться с приложением'}}); }
  const type = response.headers.get('content-type') || '';
  if (response.type === 'opaqueredirect' || response.redirected || !type.includes('application/json')) throw new ApiError(response.status === 403 ? 403 : 401, {});
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result);
  return result;
}
export const send = (path, method, data) => request(path, {method, body:JSON.stringify(data)});
export const params = values => new URLSearchParams(Object.entries(values).filter(([,v]) => v != null && v !== '')).toString();
