import type { CreateTodoBody, PushSubscriptionJson, Todo, UpdateTodoBody } from '../../shared/types';
import { IDB_TOKEN_KEY, TOKEN_STORAGE_KEY } from './constants';
import { idbSet } from './idb';

/**
 * 后端 API 客户端。
 * 生产环境同域部署，所以 base 就是相对路径 `/api`；
 * `vite dev` 时由 vite.config.ts 的 server.proxy 转发到 wrangler dev。
 */

const API_BASE = '/api';

/** 带状态码的接口错误 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 读取本地保存的 API Token */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * 保存 API Token（同时镜像到 IndexedDB 供 Service Worker 使用）。
 *
 * @param value token 原文
 */
export function setToken(value: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, value);
  } catch {
    // 隐私模式下可能写入失败，仍继续写 IDB
  }
  void idbSet(IDB_TOKEN_KEY, value).catch(() => undefined);
}

/**
 * 通用请求封装：统一带 X-Token、统一错误文案。
 *
 * @param path 相对 /api 的路径
 * @param init fetch 选项
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('X-Token', token);
  }
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, '网络连接失败，请检查网络后重试');
  }

  if (response.status === 401) {
    throw new ApiError(401, 'API Token 不正确，请到设置里重新填写');
  }

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = (await response.json()) as { error?: string };
      if (typeof data?.error === 'string' && data.error.length > 0) {
        message = data.error;
      }
    } catch {
      // 非 JSON 错误体，保留默认文案
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** 待办相关接口 */
export const api = {
  /** 健康检查（无需 token） */
  async health(): Promise<{ ok: boolean }> {
    return await request<{ ok: boolean }>('/health');
  },

  /** 拉取 VAPID 公钥（返回纯字符串） */
  async getVapidPublicKey(): Promise<string> {
    const token = getToken();
    const headers = new Headers();
    if (token) {
      headers.set('X-Token', token);
    }
    const response = await fetch(`${API_BASE}/vapid-public-key`, { headers });
    if (response.status === 401) {
      throw new ApiError(401, 'API Token 不正确，请到设置里重新填写');
    }
    if (!response.ok) {
      throw new ApiError(response.status, `获取 VAPID 公钥失败（${response.status}）`);
    }
    return (await response.text()).trim();
  },

  /** 列表：未完成在前、按截止时间升序 */
  async listTodos(): Promise<Todo[]> {
    const data = await request<{ todos: Todo[] }>('/todos');
    return data.todos ?? [];
  },

  /** 新建待办 */
  async createTodo(body: CreateTodoBody): Promise<Todo> {
    const data = await request<{ todo: Todo }>('/todos', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return data.todo;
  },

  /** 更新待办（完成状态 / 标题 / 截止时间） */
  async updateTodo(id: string, body: UpdateTodoBody): Promise<Todo> {
    const data = await request<{ todo: Todo }>(`/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return data.todo;
  },

  /** 删除待办（级联删提醒） */
  async deleteTodo(id: string): Promise<void> {
    await request<{ ok: boolean }>(`/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** 注册推送订阅 */
  async subscribe(subscription: PushSubscriptionJson): Promise<void> {
    await request<{ ok: boolean }>('/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
  },

  /** 注销推送订阅 */
  async unsubscribe(endpoint: string): Promise<void> {
    await request<{ ok: boolean }>('/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    });
  },
};
