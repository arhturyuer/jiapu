import cloudbase from '@cloudbase/js-sdk';

const env = import.meta.env.VITE_CLOUDBASE_ENV;
const functionName = import.meta.env.VITE_OPS_FUNCTION || 'youpuOpsApi';

if (!env) throw new Error('缺少 VITE_CLOUDBASE_ENV，已阻止运营后台连接未知环境');

export const cloudbaseApp = cloudbase.init({ env });
export const auth = cloudbaseApp.auth();

export async function signIn(email: string, password: string): Promise<void> {
  const currentAuth = auth as unknown as {
    signIn?: (payload: { username: string; password: string }) => Promise<unknown>;
    signInWithEmailAndPassword?: (emailValue: string, passwordValue: string) => Promise<unknown>;
  };
  if (currentAuth.signIn) {
    await currentAuth.signIn({ username: email, password });
    return;
  }
  if (currentAuth.signInWithEmailAndPassword) {
    await currentAuth.signInWithEmailAndPassword(email, password);
    return;
  }
  throw new Error('当前 CloudBase SDK 不支持邮箱登录，请检查登录认证 v2 配置');
}

export async function signOut(): Promise<void> {
  await auth.signOut();
}

export async function hasLoginState(): Promise<boolean> {
  const state = await auth.getLoginState();
  return Boolean(state);
}

export async function callOps<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await cloudbaseApp.callFunction({
    name: functionName,
    data: {
      ...data,
      action,
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }
  });
  const result = (response.result || {}) as {
    success?: boolean;
    data?: T;
    message?: string;
    requestId?: string;
  };
  if (!result.success) {
    const error = new Error(result.message || '运营请求失败');
    (error as Error & { requestId?: string }).requestId = result.requestId;
    throw error;
  }
  return result.data as T;
}
