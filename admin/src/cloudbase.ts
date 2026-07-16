import cloudbase from '@cloudbase/js-sdk';

const env = import.meta.env.VITE_CLOUDBASE_ENV;
const functionName = import.meta.env.VITE_OPS_FUNCTION || 'youpuOpsApi';

if (!env) throw new Error('缺少 VITE_CLOUDBASE_ENV，已阻止运营后台连接未知环境');

export const cloudbaseApp = cloudbase.init({ env });
export const auth = cloudbaseApp.auth();

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : null;
}

function readErrorField(error: unknown, fields: string[]): string {
  let current = asRecord(error);
  const visited = new Set<UnknownRecord>();

  for (let depth = 0; current && depth < 4 && !visited.has(current); depth += 1) {
    visited.add(current);
    for (const field of fields) {
      const value = current[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    current = asRecord(current.error) || asRecord(current.data) || asRecord(current.cause);
  }
  return '';
}

function authErrorMessage(error: unknown): string {
  const code = readErrorField(error, ['code', 'errorCode', 'errCode']);
  const rawMessage = error instanceof Error
    ? error.message
    : readErrorField(error, ['message', 'errMsg', 'error_description', 'description']);
  const fingerprint = `${code} ${rawMessage}`.toLowerCase();

  let message = rawMessage;
  if (/invalid[_ -]?(username[_ -]?or[_ -]?password|credentials?|password)|wrong[_ -]?password|user[_ -]?not[_ -]?found|账号或密码|用户名或密码|密码错误/.test(fingerprint)) {
    message = '邮箱或密码错误，请确认后重试。';
  } else if (/first[_ -]?login|password.*(update|change|required)|pwd.*update|首次登录|修改密码/.test(fingerprint)) {
    message = '该账号需要先更新初始密码，请在 CloudBase 用户管理中重置密码后重试。';
  } else if (/(email|邮箱).*(disabled|not[_ -]?enabled|unsupported|未开启|未启用)|auth[_ -]?method[_ -]?mismatch/.test(fingerprint)) {
    message = '当前环境尚未开启邮箱密码登录，请检查 CloudBase 登录方式配置。';
  } else if (/too[_ -]?many|rate[_ -]?limit|频繁|限流/.test(fingerprint)) {
    message = '登录尝试过于频繁，请稍后再试。';
  } else if (/network|fetch|timeout|timed[_ -]?out|网络|超时/.test(fingerprint)) {
    message = '暂时无法连接 CloudBase，请检查网络后重试。';
  }

  if (!message) message = 'CloudBase 登录失败';
  return code && !message.includes(code) ? `${message}（错误码：${code}）` : message;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  const message = readErrorField(error, ['message', 'errMsg', 'error_description', 'description']);
  const code = readErrorField(error, ['code', 'errorCode', 'errCode']);
  if (message && code && !message.includes(code)) return `${message}（错误码：${code}）`;
  return message || (code ? `${fallback}（错误码：${code}）` : fallback);
}

export async function signIn(email: string, password: string): Promise<void> {
  try {
    const result = await auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password
    });
    if (result.error) throw result.error;
  } catch (error) {
    throw new Error(authErrorMessage(error));
  }
}

export async function signOut(): Promise<void> {
  await auth.signOut();
}

export async function hasLoginState(): Promise<boolean> {
  const state = await auth.getLoginState();
  return Boolean(state);
}

export async function callOps<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const tokenInfo = await auth.getAccessToken();
  if (!tokenInfo?.accessToken) throw new Error('登录状态已失效，请重新登录。');
  const response = await cloudbaseApp.callFunction({
    name: functionName,
    data: {
      ...data,
      action,
      accessToken: tokenInfo.accessToken,
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }
  });
  const responseRecord = asRecord(response) || {};
  let rawResult: unknown = responseRecord.result;
  if (!rawResult && ('success' in responseRecord || 'code' in responseRecord || 'message' in responseRecord)) {
    rawResult = responseRecord;
  }
  if (typeof rawResult === 'string') {
    try {
      rawResult = JSON.parse(rawResult);
    } catch {
      rawResult = {};
    }
  }
  const result = (asRecord(rawResult) || {}) as {
    success?: boolean;
    data?: T;
    code?: string;
    message?: string;
    requestId?: string;
  };
  if (!result.success) {
    const messages: Record<string, string> = {
      UNAUTHENTICATED: '登录状态已失效，请重新登录。',
      NOT_OPERATOR: '当前账号不在运营白名单中。',
      NO_PERMISSION: '当前运营账号没有执行此操作的权限。',
      UNKNOWN_ACTION: '后台接口版本不一致，请刷新页面后重试。'
    };
    const message = result.message || (result.code && messages[result.code]) || '运营请求失败';
    const error = new Error(result.code && !message.includes(result.code)
      ? `${message}（错误码：${result.code}）`
      : message);
    Object.assign(error, { code: result.code, requestId: result.requestId });
    throw error;
  }
  return result.data as T;
}
