-- 提醒重试计数（D1 缺陷修复）
-- 推送失败时保留 sent = 0 并累加 attempts，用于补发与放弃判定；
-- 迁移前的历史行默认 0，不影响已发送的提醒。
ALTER TABLE reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
