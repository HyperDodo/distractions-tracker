export class ApiError extends Error {
  constructor(status, payload) {
    const messages = {
      EMPTY_PERIOD: 'За этот период пока нет данных для разбора.',
      INVALID_PERIOD: 'Проверьте выбранную дату и часовой пояс.',
      DELETED: 'Этот разбор удалён.',
      ID_REUSE_CONFLICT: 'Идентификатор запроса уже использован.',
    };
    super(payload?.error?.message || messages[payload?.error] || (status === 401 ? 'Необходимо восстановить вход' : status === 403 ? 'Доступ запрещён' : `Ошибка сервера (${status})`));
    this.status = status;
    this.payload = payload;
  }
}
export async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, {cache:'no-store', redirect:'manual', ...options, headers:{...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}}); }
  catch { throw new ApiError(0, {error:{message:'Не удалось связаться с приложением'}}); }
  const type = response.headers.get('content-type') || '';
  if (response.type === 'opaqueredirect' || response.redirected) throw new ApiError(401, {});
  if (!type.includes('application/json')) throw new ApiError(response.status >= 400 ? response.status : 401, {});
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result);
  return result;
}
export const send = (path, method, data) => request(path, {method, body:JSON.stringify(data)});
