-- 做了么 MVP 初始表结构
-- 时间一律为毫秒时间戳（INTEGER）

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 列表查询：未完成在前、按截止时间升序
CREATE INDEX IF NOT EXISTS idx_todos_done_deadline ON todos (done, deadline);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  fire_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);

-- Cron 扫描：sent = 0 且 fire_at <= now
CREATE INDEX IF NOT EXISTS idx_reminders_scan ON reminders (sent, fire_at);
-- 修改截止时间 / 标记完成时删除待发提醒
CREATE INDEX IF NOT EXISTS idx_reminders_todo ON reminders (todo_id, sent);

CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
