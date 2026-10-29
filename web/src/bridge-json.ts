export class BridgeResponseError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

/** Read API JSON without exposing HTML error pages or low-level JSON parser errors. */
export async function readBridgeJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) throw new BridgeResponseError(`Bridge 返回了空响应（${response.status}），请检查服务或升级后端。`, response.status);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new BridgeResponseError(`Bridge 返回的不是有效 JSON（${response.status}），请检查代理地址或后端版本。`, response.status); }
  if (value === null || typeof value !== "object") throw new BridgeResponseError(`Bridge 响应格式不兼容（${response.status}），请升级后端。`, response.status);
  return value as T;
}
