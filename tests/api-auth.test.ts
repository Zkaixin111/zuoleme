/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from 'vitest';
import { handleApi } from '../worker/src/api';
import type { Env } from '../worker/src/env';
import { FakeD1 } from './helpers/fake-d1';

/**
 * API 鉴权覆盖面测试。
 *
 * 目标：证明「除了 /api/health，没有任何一个路由能在没有 X-Token 的情况下被访问」。
 * 漏一个路由的后果是：任何人拿到 Worker 域名就能读写用户的待办、注册/删除推送订阅。
 *
 * 做法：把所有已知路由 × (无 token / 错 token) 穷举一遍，
 * 再额外验证「未带 token 访问不存在的路径也返回 401 而不是 404」——
 * 这条能证明鉴权发生在路由分发**之前**，因此不可能有路由漏检。
 */

const TOKEN = 'qa-secret-token';
const BASE = 'https://zuoleme.example.workers.dev';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_TOKEN: TOKEN,
    VAPID_PUBLIC_KEY: 'qa-vapid-public-key',
    VAPID_PRIVATE_KEY: 'qa-vapid-private-key',
    VAPID_SUBJECT: 'mailto:qa@example.com',
    DB: new FakeD1() as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ...overrides,
  };
}

function makeRequest(method: string, path: string, token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) {
    headers.set('X-Token', token);
  }
  if (method === 'POST' || method === 'PATCH') {
    headers.set('Content-Type', 'application/json');
  }
  const body = method === 'GET' || method === 'DELETE' || method === 'HEAD' ? undefined : '{}';
  return new Request(`${BASE}${path}`, { method, headers, body });
}

/** 需要鉴权的全部路由（method + path） */
const PROTECTED_ROUTES: ReadonlyArray<{ method: string; path: string; note: string }> = [
  { method: 'GET', path: '/api/vapid-public-key', note: 'VAPID 公钥' },
  { method: 'GET', path: '/api/todos', note: '待办列表' },
  { method: 'POST', path: '/api/todos', note: '新建待办' },
  { method: 'PATCH', path: '/api/todos/todo-1', note: '修改待办' },
  { method: 'DELETE', path: '/api/todos/todo-1', note: '删除待办' },
  { method: 'POST', path: '/api/subscribe', note: '注册推送订阅' },
  { method: 'POST', path: '/api/unsubscribe', note: '注销推送订阅' },
];

describe('鉴权覆盖面：无 token / 错 token 一律 401', () => {
  for (const route of PROTECTED_ROUTES) {
    it(`${route.method} ${route.path}（${route.note}）缺少 X-Token → 401`, async () => {
      const response = await handleApi(makeRequest(route.method, route.path), makeEnv());
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('未授权');
    });

    it(`${route.method} ${route.path}（${route.note}）X-Token 错误 → 401`, async () => {
      const response = await handleApi(makeRequest(route.method, route.path, 'wrong-token'), makeEnv());
      expect(response.status).toBe(401);
    });
  }

  it('长度相同但内容不同的 token 也必须被拒绝（定长比较不能退化成前缀匹配）', async () => {
    const sameLength = 'X'.repeat(TOKEN.length);
    const response = await handleApi(makeRequest('GET', '/api/todos', sameLength), makeEnv());
    expect(response.status).toBe(401);
  });

  it('鉴权发生在路由分发之前：不存在的路径未带 token 也返回 401 而不是 404', async () => {
    const response = await handleApi(makeRequest('GET', '/api/not-a-real-route'), makeEnv());
    expect(response.status).toBe(401);
  });

  it('未配置 API_TOKEN → 500 并给出可执行的中文提示（不能误报 401）', async () => {
    const response = await handleApi(makeRequest('GET', '/api/todos'), makeEnv({ API_TOKEN: '' }));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('API_TOKEN');
  });
});

describe('鉴权后的正常路径（确认测试里的 token 是「对的那一把」）', () => {
  it('GET /api/health 不需要 token', async () => {
    const response = await handleApi(makeRequest('GET', '/api/health'), makeEnv({ API_TOKEN: '' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('GET /api/vapid-public-key 带正确 token → 返回纯文本公钥', async () => {
    const response = await handleApi(makeRequest('GET', '/api/vapid-public-key', TOKEN), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('qa-vapid-public-key');
  });

  it('GET /api/todos 带正确 token → 200 且结构为 { todos: [] }', async () => {
    const response = await handleApi(makeRequest('GET', '/api/todos', TOKEN), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ todos: [] });
  });
});

describe('错误响应的可读性', () => {
  it('非法 JSON 请求体 → 400 而非 500', async () => {
    const request = new Request(`${BASE}/api/todos`, {
      method: 'POST',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      body: '{ this is not json',
    });
    const response = await handleApi(request, makeEnv());
    expect(response.status).toBe(400);
  });

  it('标题为空 → 400 且提示里包含长度上限', async () => {
    const request = new Request(`${BASE}/api/todos`, {
      method: 'POST',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', deadline: Date.now() + 86_400_000 }),
    });
    const response = await handleApi(request, makeEnv());
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('200');
  });

  it('截止时间不在未来 → 400', async () => {
    const request = new Request(`${BASE}/api/todos`, {
      method: 'POST',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '交周报', deadline: Date.now() - 1 }),
    });
    const response = await handleApi(request, makeEnv());
    expect(response.status).toBe(400);
  });

  it('subscribe 的 endpoint 不是 https → 400', async () => {
    const request = new Request(`${BASE}/api/subscribe`, {
      method: 'POST',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'http://insecure.example.com/push', keys: { p256dh: 'a', auth: 'b' } }),
    });
    const response = await handleApi(request, makeEnv());
    expect(response.status).toBe(400);
  });
});
