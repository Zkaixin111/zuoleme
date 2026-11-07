import type { CreateTodoBody, Todo, TodoRow, UpdateTodoBody } from '../../shared/types';
import {
  deleteSubByEndpoint,
  deleteTodoCascade,
  findTodo,
  insertTodo,
  listTodos,
  setTodoDone,
  updateTodoFields,
  upsertSub,
} from './db';
import type { Env } from './env';

/**
 * REST API 层（原生 Request/Response，不引框架）。
 *
 * 除 /api/health 外全部要求 `X-Token` 头，与 API_TOKEN secret 比对。
 * 前后端同域部署，因此不设 CORS 头。
 */

const TITLE_MAX_LENGTH = 200;

/** JSON 响应（统一 UTF-8，禁用中间层缓存） */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** 错误响应 */
function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** 定长比较，避免 token 比较被时间侧信道利用 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** D1 行 → 接口返回结构 */
function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    deadline: row.deadline,
    done: row.done === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextFireAt: row.next_fire_at ?? null,
  };
}

/** 安全解析 JSON 请求体 */
async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/** 标题校验：去空格后非空且不超过 200 字 */
function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const title = raw.trim();
  if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
    return null;
  }
  return title;
}

/** 截止时间校验：必须是未来的毫秒时间戳 */
function normalizeDeadline(raw: unknown, now: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  if (raw <= now) {
    return null;
  }
  return Math.floor(raw);
}

/**
 * API 入口。返回 null 表示该路径不属于此处（交给静态资源）。
 *
 * @param request 原始请求
 * @param env 运行环境
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const now = Date.now();

  // 健康检查不需要鉴权
  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true });
  }

  if (!env.API_TOKEN) {
    return errorResponse('服务端未配置 API_TOKEN，请先执行 wrangler secret put API_TOKEN', 500);
  }

  const token = request.headers.get('X-Token') ?? '';
  if (!safeEqual(token, env.API_TOKEN)) {
    return errorResponse('未授权：X-Token 不正确', 401);
  }

  // ---------- VAPID 公钥（纯字符串，前端订阅时用） ----------
  if (path === '/api/vapid-public-key' && method === 'GET') {
    if (!env.VAPID_PUBLIC_KEY) {
      return errorResponse('服务端未配置 VAPID_PUBLIC_KEY', 500);
    }
    return new Response(env.VAPID_PUBLIC_KEY, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // ---------- 待办集合 ----------
  if (path === '/api/todos') {
    if (method === 'GET') {
      const rows = await listTodos(env.DB);
      return json({ todos: rows.map(toTodo) });
    }

    if (method === 'POST') {
      const body = await readJsonBody<CreateTodoBody>(request);
      if (!body) {
        return errorResponse('请求体必须是 JSON 对象', 400);
      }
      const title = normalizeTitle(body.title);
      if (!title) {
        return errorResponse(`标题不能为空且不超过 ${TITLE_MAX_LENGTH} 字`, 400);
      }
      const deadline = normalizeDeadline(body.deadline, now);
      if (deadline === null) {
        return errorResponse('截止时间必须是未来的毫秒时间戳', 400);
      }

      const id = await insertTodo(env.DB, { title, deadline, now });
      const row = await findTodo(env.DB, id);
      if (!row) {
        return errorResponse('创建后读取失败', 500);
      }
      return json({ todo: toTodo(row) }, 201);
    }

    return errorResponse('方法不被支持', 405);
  }

  // ---------- 单条待办 ----------
  const todoMatch = /^\/api\/todos\/([^/]+)$/.exec(path);
  if (todoMatch) {
    const id = decodeURIComponent(todoMatch[1]);

    if (method === 'PATCH') {
      const body = await readJsonBody<UpdateTodoBody>(request);
      if (!body) {
        return errorResponse('请求体必须是 JSON 对象', 400);
      }

      const existing = await findTodo(env.DB, id);
      if (!existing) {
        return errorResponse('待办不存在', 404);
      }

      const hasTitle = body.title !== undefined;
      const hasDeadline = body.deadline !== undefined;
      const hasDone = body.done !== undefined;

      if (!hasTitle && !hasDeadline && !hasDone) {
        return errorResponse('至少需要提供 title / deadline / done 之一', 400);
      }

      let title: string | undefined;
      if (hasTitle) {
        const normalized = normalizeTitle(body.title);
        if (!normalized) {
          return errorResponse(`标题不能为空且不超过 ${TITLE_MAX_LENGTH} 字`, 400);
        }
        title = normalized;
      }

      let deadline: number | undefined;
      if (hasDeadline) {
        const normalized = normalizeDeadline(body.deadline, now);
        if (normalized === null) {
          return errorResponse('截止时间必须是未来的毫秒时间戳', 400);
        }
        deadline = normalized;
      }

      if (hasDone && typeof body.done !== 'boolean') {
        return errorResponse('done 必须是布尔值', 400);
      }

      if (hasTitle || hasDeadline) {
        await updateTodoFields(env.DB, id, { title, deadline }, now);
      }
      if (hasDone) {
        await setTodoDone(env.DB, id, body.done === true, now);
      }

      const updated = await findTodo(env.DB, id);
      if (!updated) {
        return errorResponse('更新后读取失败', 500);
      }
      return json({ todo: toTodo(updated) });
    }

    if (method === 'DELETE') {
      const deleted = await deleteTodoCascade(env.DB, id);
      if (!deleted) {
        return errorResponse('待办不存在', 404);
      }
      return json({ ok: true });
    }

    return errorResponse('方法不被支持', 405);
  }

  // ---------- 订阅 ----------
  if (path === '/api/subscribe' && method === 'POST') {
    const body = await readJsonBody<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>(request);
    if (!body) {
      return errorResponse('请求体必须是 JSON 对象', 400);
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
    const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';

    if (!endpoint.startsWith('https://')) {
      return errorResponse('endpoint 必须是 https 地址', 400);
    }
    if (!p256dh || !auth) {
      return errorResponse('缺少 keys.p256dh 或 keys.auth', 400);
    }

    const id = await upsertSub(env.DB, { endpoint, p256dh, auth }, now);
    return json({ ok: true, id });
  }

  if (path === '/api/unsubscribe' && method === 'POST') {
    const body = await readJsonBody<{ endpoint?: unknown }>(request);
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      return errorResponse('缺少 endpoint', 400);
    }
    await deleteSubByEndpoint(env.DB, endpoint);
    return json({ ok: true });
  }

  return errorResponse('接口不存在', 404);
}
