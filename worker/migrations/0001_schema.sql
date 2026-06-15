CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  subscription_username TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscription_prefixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url_prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_prefixes_enabled_sort ON subscription_prefixes(enabled, sort_order);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('node_display_text_title', '节点文字'),
  ('node_display_table_title', '节点表格'),
  ('node_display_text', '登录后可在这里展示节点说明。管理员可以在后台任意编辑这段文字。'),
  ('node_display_table', '{"columns":["协议","服务器","端口","备注"],"rows":[]}'),
  ('shadowrocket_use_base64', 'false'),
  ('ipv6_mapping', '{"107.173.127.179":["2001:470:c:117c::101","2001:470:c:117c::102","2001:470:c:117c::103","2001:470:c:117c::104","2001:470:c:117c::105","2001:470:c:117c::106"],"23.159.248.103":["2001:470:c:ef0::101","2001:470:c:ef0::102","2001:470:c:ef0::103","2001:470:c:ef0::104"]}');
