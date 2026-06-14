import qrcode from "qrcode-generator";
import DEFAULT_TEMPLATE from "../template.yaml";

type Env = {
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
};

type UserRecord = {
  id: number;
  username: string;
  subscription_username: string | null;
  is_admin: number;
  is_active: number;
  created_at: string;
  updated_at: string;
};

type SessionUser = {
  id: number;
  username: string;
  subscriptionUsername: string;
  isAdmin: boolean;
  isActive: boolean;
};

type ProxyNode = {
  name: string;
  type: string;
  server: string;
  port?: number;
  [key: string]: unknown;
};

type DisplayTable = {
  columns: string[];
  rows: Array<{ name: string; cells: string[] }>;
};

type SubscriptionPrefix = {
  id: number;
  name: string;
  url_prefix: string;
  enabled: number;
  sort_order: number;
};

type SourceStatus = {
  name: string;
  url?: string;
  ok: boolean;
  nodes: number;
  error?: string;
};

type FetchSubscriptionResult = {
  name: string;
  url: string;
  ok: boolean;
  nodeCount: number;
  nodes: ProxyNode[];
  entries: ParsedNodeEntry[];
  error?: string;
};

type AppendIpv6Result = {
  nodes: ProxyNode[];
  ipv6Entries: ParsedNodeEntry[];
};

type ParsedSubscriptionContent = {
  nodes: ProxyNode[];
  entries: ParsedNodeEntry[];
};

type ParsedNodeEntry = {
  node: ProxyNode;
  shareLink: string;
};

type ShadowrocketBundle = {
  text: string;
  qrDataUrl: string | null;
  qrError: string | null;
  linkCount: number;
  useBase64: boolean;
};

const SESSION_COOKIE = "vps_sub_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 100000;
const DEFAULT_TABLE: DisplayTable = {
  columns: ["协议", "服务器", "端口", "备注"],
  rows: [],
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await ensureBootstrapAdmin(env);
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return htmlResponse(APP_HTML);
      }

      if (url.pathname === "/subscription.yaml" && request.method === "GET") {
        const user = await requireUser(request, env);
        const result = await generateConfigForUser(env, user);
        return new Response(result.yaml, {
          headers: {
            "content-type": "text/yaml; charset=utf-8",
            "content-disposition": 'attachment; filename="subscription.yaml"',
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }

      return notFound();
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      console.error(error);
      return jsonResponse({ error: "服务器内部错误" }, 500);
    }
  },
};

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/login" && request.method === "POST") {
    return await login(request, env);
  }

  if (path === "/api/logout" && request.method === "POST") {
    return await logout(request, env);
  }

  if (path === "/api/me" && request.method === "GET") {
    const user = await requireUser(request, env);
    const content = await getDisplayContent(env);
    return jsonResponse({ user, content });
  }

  if (path === "/api/generate" && request.method === "POST") {
    const user = await requireUser(request, env);
    const result = await generateConfigForUser(env, user);
    return jsonResponse({
      yaml: result.yaml,
      nodeCount: result.nodeCount,
      sources: result.sources.map(withoutSourceUrl),
      shadowrocketText: result.shadowrocket.text,
      shadowrocketQrDataUrl: result.shadowrocket.qrDataUrl,
      shadowrocketQrError: result.shadowrocket.qrError,
      shadowrocketLinkCount: result.shadowrocket.linkCount,
      shadowrocketUseBase64: result.shadowrocket.useBase64,
    });
  }

  const admin = await requireAdmin(request, env);

  if (path === "/api/admin/users" && request.method === "GET") {
    return jsonResponse({ users: await listUsers(env) });
  }

  if (path === "/api/admin/users" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const user = await createUser(env, body);
    return jsonResponse({ user }, 201);
  }

  const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && request.method === "PATCH") {
    const body = await readJson<Record<string, unknown>>(request);
    const user = await updateUser(env, Number(userMatch[1]), body);
    return jsonResponse({ user });
  }

  if (userMatch && request.method === "DELETE") {
    await deleteUser(env, Number(userMatch[1]), admin.id);
    return jsonResponse({ ok: true });
  }

  if (path === "/api/admin/content" && request.method === "GET") {
    return jsonResponse(await getDisplayContent(env));
  }

  if (path === "/api/admin/content" && request.method === "PUT") {
    const body = await readJson<Record<string, unknown>>(request);
    const text = typeof body.text === "string" ? body.text : "";
    const table = normalizeDisplayTable(body.table);
    await setSetting(env, "node_display_text", text);
    await setSetting(env, "node_display_table", JSON.stringify(table));
    await setSetting(env, "shadowrocket_use_base64", boolField(body.shadowrocketUseBase64) ? "true" : "false");
    return jsonResponse(await getDisplayContent(env));
  }

  if (path === "/api/admin/ipv6-mappings" && request.method === "GET") {
    return jsonResponse({ mapping: await getIpv6Mapping(env) });
  }

  if (path === "/api/admin/ipv6-mappings" && request.method === "PUT") {
    const body = await readJson<Record<string, unknown>>(request);
    const mapping = normalizeIpv6Mapping(body.mapping);
    await setSetting(env, "ipv6_mapping", JSON.stringify(mapping));
    return jsonResponse({ mapping });
  }

  if (path === "/api/admin/prefixes" && request.method === "GET") {
    return jsonResponse({ prefixes: await listPrefixes(env, false) });
  }

  if (path === "/api/admin/prefixes" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const prefix = await createPrefix(env, body);
    return jsonResponse({ prefix }, 201);
  }

  const prefixMatch = path.match(/^\/api\/admin\/prefixes\/(\d+)$/);
  if (prefixMatch && request.method === "PATCH") {
    const body = await readJson<Record<string, unknown>>(request);
    const prefix = await updatePrefix(env, Number(prefixMatch[1]), body);
    return jsonResponse({ prefix });
  }

  if (prefixMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM subscription_prefixes WHERE id = ?").bind(Number(prefixMatch[1])).run();
    return jsonResponse({ ok: true });
  }

  return notFound();
}

async function ensureBootstrapAdmin(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if ((row?.count ?? 0) > 0) {
    return;
  }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return;
  }
  const hash = await hashPassword(env.ADMIN_PASSWORD);
  await env.DB.prepare(
    "INSERT INTO users(username, password_hash, subscription_username, is_admin, is_active) VALUES (?, ?, ?, 1, 1)",
  )
    .bind(env.ADMIN_USERNAME, hash, env.ADMIN_USERNAME)
    .run();
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const username = stringField(body.username, "用户名");
  const password = stringField(body.password, "密码");
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRecord & { password_hash: string }>();

  if (!row || row.is_active !== 1 || !(await verifyPassword(password, row.password_hash))) {
    throw new HttpError(401, "用户名或密码不正确");
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, row.id, expiresAt)
    .run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
  return jsonResponse({ user: toSessionUser(row) }, 200, { "set-cookie": cookie });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = getSessionToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  return jsonResponse({ ok: true }, 200, {
    "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  });
}

async function requireUser(request: Request, env: Env): Promise<SessionUser> {
  const token = getSessionToken(request);
  if (!token) {
    throw new HttpError(401, "请先登录");
  }
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.subscription_username, u.is_admin, u.is_active, u.created_at, u.updated_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), now)
    .first<UserRecord>();

  if (!row || row.is_active !== 1) {
    throw new HttpError(401, "登录已失效");
  }
  return toSessionUser(row);
}

async function requireAdmin(request: Request, env: Env): Promise<SessionUser> {
  const user = await requireUser(request, env);
  if (!user.isAdmin) {
    throw new HttpError(403, "需要管理员权限");
  }
  return user;
}

function getSessionToken(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  return cookies[SESSION_COOKIE] || null;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function toSessionUser(row: UserRecord): SessionUser {
  return {
    id: row.id,
    username: row.username,
    subscriptionUsername: row.subscription_username || row.username,
    isAdmin: row.is_admin === 1,
    isActive: row.is_active === 1,
  };
}

async function listUsers(env: Env): Promise<Array<Omit<UserRecord, "password_hash">>> {
  const result = await env.DB.prepare(
    "SELECT id, username, subscription_username, is_admin, is_active, created_at, updated_at FROM users ORDER BY id ASC",
  ).all<Omit<UserRecord, "password_hash">>();
  return result.results || [];
}

async function createUser(env: Env, body: Record<string, unknown>): Promise<Omit<UserRecord, "password_hash">> {
  const username = stringField(body.username, "用户名");
  const password = stringField(body.password, "密码");
  if (password.length < 6) {
    throw new HttpError(400, "密码至少需要 6 位");
  }
  const subscriptionUsername = optionalString(body.subscriptionUsername) || username;
  const passwordHash = await hashPassword(password);
  const isAdmin = boolField(body.isAdmin) ? 1 : 0;
  const isActive = body.isActive === undefined ? 1 : boolField(body.isActive) ? 1 : 0;

  try {
    await env.DB.prepare(
      "INSERT INTO users(username, password_hash, subscription_username, is_admin, is_active) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(username, passwordHash, subscriptionUsername, isAdmin, isActive)
      .run();
  } catch {
    throw new HttpError(409, "用户名已存在");
  }

  const user = await env.DB.prepare(
    "SELECT id, username, subscription_username, is_admin, is_active, created_at, updated_at FROM users WHERE username = ?",
  )
    .bind(username)
    .first<Omit<UserRecord, "password_hash">>();
  if (!user) throw new HttpError(500, "创建用户失败");
  return user;
}

async function updateUser(env: Env, id: number, body: Record<string, unknown>): Promise<Omit<UserRecord, "password_hash">> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRecord & { password_hash: string }>();
  if (!existing) {
    throw new HttpError(404, "用户不存在");
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let nextIsAdmin = existing.is_admin === 1;
  let nextIsActive = existing.is_active === 1;

  if (body.username !== undefined) {
    sets.push("username = ?");
    values.push(stringField(body.username, "用户名"));
  }
  if (body.subscriptionUsername !== undefined) {
    sets.push("subscription_username = ?");
    values.push(optionalString(body.subscriptionUsername) || null);
  }
  if (body.password !== undefined && optionalString(body.password)) {
    const password = stringField(body.password, "密码");
    if (password.length < 6) {
      throw new HttpError(400, "密码至少需要 6 位");
    }
    sets.push("password_hash = ?");
    values.push(await hashPassword(password));
  }
  if (body.isAdmin !== undefined) {
    nextIsAdmin = boolField(body.isAdmin);
    sets.push("is_admin = ?");
    values.push(nextIsAdmin ? 1 : 0);
  }
  if (body.isActive !== undefined) {
    nextIsActive = boolField(body.isActive);
    sets.push("is_active = ?");
    values.push(nextIsActive ? 1 : 0);
  }

  if (sets.length === 0) {
    return existing;
  }

  if (existing.is_admin === 1 && (!nextIsAdmin || !nextIsActive) && (await countActiveAdmins(env)) <= 1) {
    throw new HttpError(400, "不能禁用或降权最后一个管理员");
  }

  sets.push("updated_at = CURRENT_TIMESTAMP");
  try {
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
  } catch {
    throw new HttpError(409, "用户名已存在");
  }

  const user = await env.DB.prepare(
    "SELECT id, username, subscription_username, is_admin, is_active, created_at, updated_at FROM users WHERE id = ?",
  )
    .bind(id)
    .first<Omit<UserRecord, "password_hash">>();
  if (!user) throw new HttpError(500, "更新用户失败");
  return user;
}

async function deleteUser(env: Env, id: number, currentUserId: number): Promise<void> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRecord>();
  if (!existing) return;
  if (id === currentUserId) {
    throw new HttpError(400, "不能删除当前登录的账号");
  }
  if (existing.is_admin === 1 && (await countActiveAdmins(env)) <= 1) {
    throw new HttpError(400, "不能删除最后一个管理员");
  }
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

async function countActiveAdmins(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1 AND is_active = 1").first<{ count: number }>();
  return row?.count || 0;
}

async function getDisplayContent(
  env: Env,
): Promise<{
  text: string;
  table: DisplayTable;
  shadowrocketUseBase64: boolean;
}> {
  const text = await getSetting(env, "node_display_text", "");
  const tableRaw = await getSetting(env, "node_display_table", JSON.stringify(DEFAULT_TABLE));
  const shadowrocketUseBase64 = (await getSetting(env, "shadowrocket_use_base64", "false")) === "true";
  let table = DEFAULT_TABLE;
  try {
    table = normalizeDisplayTable(JSON.parse(tableRaw));
  } catch {
    table = DEFAULT_TABLE;
  }
  return {
    text,
    table,
    shadowrocketUseBase64,
  };
}

async function getSetting(env: Env, key: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(key, value)
    .run();
}

async function getIpv6Mapping(env: Env): Promise<Record<string, string[]>> {
  const raw = await getSetting(env, "ipv6_mapping", "{}");
  try {
    return normalizeIpv6Mapping(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function listPrefixes(env: Env, enabledOnly: boolean): Promise<SubscriptionPrefix[]> {
  const sql = enabledOnly
    ? "SELECT * FROM subscription_prefixes WHERE enabled = 1 ORDER BY sort_order ASC, id ASC"
    : "SELECT * FROM subscription_prefixes ORDER BY sort_order ASC, id ASC";
  const result = await env.DB.prepare(sql).all<SubscriptionPrefix>();
  return result.results || [];
}

async function createPrefix(env: Env, body: Record<string, unknown>): Promise<SubscriptionPrefix> {
  const name = stringField(body.name, "前缀名称");
  const urlPrefix = stringField(body.urlPrefix, "订阅链接前缀");
  const enabled = body.enabled === undefined ? 1 : boolField(body.enabled) ? 1 : 0;
  const sortOrder = numberField(body.sortOrder, 0);

  await env.DB.prepare(
    "INSERT INTO subscription_prefixes(name, url_prefix, enabled, sort_order) VALUES (?, ?, ?, ?)",
  )
    .bind(name, urlPrefix, enabled, sortOrder)
    .run();

  const row = await env.DB.prepare("SELECT * FROM subscription_prefixes ORDER BY id DESC LIMIT 1").first<SubscriptionPrefix>();
  if (!row) throw new HttpError(500, "创建前缀失败");
  return row;
}

async function updatePrefix(env: Env, id: number, body: Record<string, unknown>): Promise<SubscriptionPrefix> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) {
    sets.push("name = ?");
    values.push(stringField(body.name, "前缀名称"));
  }
  if (body.urlPrefix !== undefined) {
    sets.push("url_prefix = ?");
    values.push(stringField(body.urlPrefix, "订阅链接前缀"));
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(boolField(body.enabled) ? 1 : 0);
  }
  if (body.sortOrder !== undefined) {
    sets.push("sort_order = ?");
    values.push(numberField(body.sortOrder, 0));
  }
  if (sets.length) {
    sets.push("updated_at = CURRENT_TIMESTAMP");
    await env.DB.prepare(`UPDATE subscription_prefixes SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
  }
  const row = await env.DB.prepare("SELECT * FROM subscription_prefixes WHERE id = ?").bind(id).first<SubscriptionPrefix>();
  if (!row) throw new HttpError(404, "前缀不存在");
  return row;
}

async function generateConfigForUser(
  env: Env,
  user: SessionUser,
): Promise<{ yaml: string; nodeCount: number; sources: SourceStatus[]; shadowrocket: ShadowrocketBundle }> {
  const prefixes = await listPrefixes(env, true);
  if (prefixes.length === 0) {
    throw new HttpError(400, "管理员还没有配置任何订阅链接前缀");
  }

  const subscriptionName = user.subscriptionUsername || user.username;
  const jobs = prefixes.map((prefix) => ({
    name: prefix.name,
    url: buildSubscriptionUrl(prefix.url_prefix, subscriptionName),
  }));
  const fetched = await fetchSubscriptionsInBatches(jobs);
  const sources: SourceStatus[] = [];
  const nodes: ProxyNode[] = [];
  const sourceEntries: ParsedNodeEntry[] = [];

  for (const result of fetched) {
    sources.push({
      name: result.name,
      ok: result.ok,
      nodes: result.nodeCount,
      error: result.error,
    });
    nodes.push(...result.nodes);
    sourceEntries.push(...result.entries);
  }

  if (nodes.length === 0) {
    const details = sources.map((source) => `${source.name}: ${source.error || "未解析到节点"}`).join("；");
    throw new HttpError(502, details ? `没有从订阅源解析到节点。${details}` : "没有从订阅源解析到节点");
  }

  const mapped = appendIpv6Nodes(nodes, sourceEntries, await getIpv6Mapping(env));
  const uniqueNodes = dedupeNodeNames(mapped.nodes);
  const yaml = generateYaml(DEFAULT_TEMPLATE, uniqueNodes);
  const shadowrocketLinks = [...sourceEntries.map((entry) => entry.shareLink), ...mapped.ipv6Entries.map((entry) => entry.shareLink)];
  const shadowrocketUseBase64 = (await getSetting(env, "shadowrocket_use_base64", "false")) === "true";
  const shadowrocket = buildShadowrocketBundle(shadowrocketLinks, shadowrocketUseBase64);
  return { yaml, nodeCount: uniqueNodes.length, sources, shadowrocket };
}

function withoutSourceUrl(source: SourceStatus): SourceStatus {
  return {
    name: source.name,
    ok: source.ok,
    nodes: source.nodes,
    error: source.error,
  };
}

function buildSubscriptionUrl(prefix: string, username: string): string {
  const encoded = encodeURIComponent(username);
  return prefix.includes("{username}") ? prefix.replaceAll("{username}", encoded) : prefix + encoded;
}

async function fetchSubscriptionsInBatches(
  jobs: Array<{ name: string; url: string }>,
): Promise<FetchSubscriptionResult[]> {
  const results: FetchSubscriptionResult[] = [];
  for (let i = 0; i < jobs.length; i += 6) {
    const batch = jobs.slice(i, i + 6);
    const settled = await Promise.all(batch.map((job) => fetchSubscription(job.name, job.url)));
    results.push(...settled);
  }
  return results;
}

async function fetchSubscription(name: string, url: string): Promise<FetchSubscriptionResult> {
  try {
    const response = await fetchSubscriptionWithRetries(url);
    const content = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(describeHttpErrorClean(response.status, content));
    }
    const parsed = parseSubscriptionContent(content);
    return {
      name,
      url,
      ok: true,
      nodeCount: parsed.nodes.length,
      nodes: parsed.nodes,
      entries: parsed.entries,
      error: parsed.nodes.length ? undefined : describeUnparsedContent(content, response.headers.get("content-type") || ""),
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      nodeCount: 0,
      nodes: [],
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchSubscriptionWithRetries(url: string): Promise<Response> {
  return fetch(url, { redirect: "follow" });
}

function describeHttpError(status: number, body = ""): string {
  const detail = summarizeHttpErrorBody(body);
  if (status === 403) {
    return `HTTP 403，源站或中转拒绝请求；请检查 relay token、订阅接口权限、来源 IP、防火墙或访问路径${detail}`;
  }
  if (status === 401) {
    return `HTTP 401，订阅接口或中转需要认证${detail}`;
  }
  if (status === 404) {
    return `HTTP 404，订阅链接或中转路径不存在，请检查前缀、用户订阅名和 relay 地址${detail}`;
  }
  if (status === 429) {
    return `HTTP 429，订阅源或中转限流${detail}`;
  }
  return `HTTP ${status}${detail}`;
}

function summarizeHttpErrorBody(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const error = typeof data.error === "string" ? data.error : "";
    if (error) return `：${error.slice(0, 180)}`;
  } catch {
    // Not JSON; fall through to a plain-text sample.
  }
  const sample = text.replace(/\s+/g, " ").slice(0, 180);
  return sample ? `：${sample}` : "";
}

function describeHttpErrorClean(status: number, body = ""): string {
  const detail = summarizeHttpErrorBodyClean(body);
  if (status === 403) {
    return `HTTP 403, subscription source refused the request. Check subscription permissions, source IP, firewall, or path${detail}`;
  }
  if (status === 401) {
    return `HTTP 401, subscription source requires authentication${detail}`;
  }
  if (status === 404) {
    return `HTTP 404, subscription URL does not exist. Check prefix and subscription username${detail}`;
  }
  if (status === 429) {
    return `HTTP 429, subscription source is rate limited${detail}`;
  }
  return `HTTP ${status}${detail}`;
}

function summarizeHttpErrorBodyClean(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const error = typeof data.error === "string" ? data.error : "";
    if (error) return `: ${error.slice(0, 180)}`;
  } catch {
    // Not JSON; fall through to a plain-text sample.
  }
  const sample = text.replace(/\s+/g, " ").slice(0, 180);
  return sample ? `: ${sample}` : "";
}

function parseSubscriptionContent(content: string): ParsedSubscriptionContent {
  const rawJsonNodes = parseSingboxJsonContent(content);
  if (rawJsonNodes.length) {
    return { nodes: rawJsonNodes, entries: [] };
  }

  let decoded = content;
  try {
    decoded = decodeBase64Utf8(content);
  } catch {
    decoded = content;
  }

  const decodedJsonNodes = decoded === content ? [] : parseSingboxJsonContent(decoded);
  if (decodedJsonNodes.length) {
    return { nodes: decodedJsonNodes, entries: [] };
  }

  const clashYamlNodes = parseClashYaml(decoded);
  if (clashYamlNodes.length) {
    return { nodes: clashYamlNodes, entries: [] };
  }

  const nodes: ProxyNode[] = [];
  const entries: ParsedNodeEntry[] = [];
  for (const line of decoded.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) continue;
    const node = parseNodeUrl(item);
    if (node) {
      nodes.push(node);
      entries.push({ node, shareLink: item });
    }
  }
  return { nodes, entries };
}

function parseSingboxJsonContent(content: string): ProxyNode[] {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    return Array.isArray(data.outbounds) ? parseSingboxJson(data) : [];
  } catch {
    return [];
  }
}

function describeUnparsedContent(content: string, contentType: string): string {
  const sample = content.slice(0, 300).trim().toLowerCase();
  if (contentType.includes("text/html") || sample.startsWith("<!doctype html") || sample.startsWith("<html")) {
    return "订阅源返回的是 HTML 页面，不是订阅内容；请检查前缀是否填成了管理面板地址，应该使用真正的订阅接口";
  }
  if (!content) {
    return "订阅源返回空内容";
  }
  if (sample.includes("login") || sample.includes("password")) {
    return "订阅源看起来返回了登录页面，请检查订阅接口是否需要认证或前缀是否正确";
  }
  return "订阅源返回内容无法识别；当前支持原始节点链接、base64 节点链接列表、Sing-Box JSON、Clash/Mihomo YAML";
}

function parseClashYaml(content: string): ProxyNode[] {
  if (!/^proxies:\s*$/m.test(content)) {
    return [];
  }

  const block = extractRootBlock(content, "proxies");
  const nodes: ProxyNode[] = [];
  let current: ProxyNode | null = null;
  let arrayKey: string | null = null;
  let objectKey: string | null = null;

  const pushCurrent = () => {
    if (!current) return;
    if (current.name && current.type && current.server) {
      if (current.type === "hy2") current.type = "hysteria2";
      nodes.push(current);
    }
  };

  for (let i = 0; i < block.length; i += 1) {
    const line = block[i];
    const itemMatch = line.match(/^  -\s+(.+)$/);
    if (itemMatch) {
      pushCurrent();
      current = { name: "undefined", type: "", server: "" };
      arrayKey = null;
      objectKey = null;
      applyYamlPair(current, itemMatch[1]);
      continue;
    }

    if (!current) continue;

    const pairMatch = line.match(/^    ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pairMatch) {
      const key = pairMatch[1];
      const rawValue = pairMatch[2];
      arrayKey = null;
      objectKey = null;
      if (rawValue === "") {
        const next = block[i + 1] || "";
        if (/^      -\s+/.test(next)) {
          current[key] = [];
          arrayKey = key;
        } else {
          current[key] = {};
          objectKey = key;
        }
      } else {
        current[key] = parseYamlValueForKey(key, rawValue);
      }
      continue;
    }

    const arrayMatch = line.match(/^      -\s+(.+)$/);
    if (arrayMatch && arrayKey && Array.isArray(current[arrayKey])) {
      (current[arrayKey] as string[]).push(String(parseYamlScalar(arrayMatch[1])));
      continue;
    }

    const objectMatch = line.match(/^      ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (objectMatch && objectKey && isRecord(current[objectKey])) {
      (current[objectKey] as Record<string, unknown>)[objectMatch[1]] = parseYamlValueForKey(objectMatch[1], objectMatch[2]);
    }
  }

  pushCurrent();
  return nodes.filter((node) => ["vless", "tuic", "hysteria2", "trojan"].includes(node.type));
}

function applyYamlPair(target: ProxyNode, text: string): void {
  const index = text.indexOf(":");
  if (index === -1) return;
  const key = text.slice(0, index).trim();
  const rawValue = text.slice(index + 1).trim();
  target[key] = parseYamlValueForKey(key, rawValue);
}

function parseYamlValueForKey(key: string, rawValue: string): unknown {
  const value = parseYamlScalar(rawValue);
  if (["port", "server_port"].includes(key)) {
    const port = Number(value);
    return Number.isFinite(port) ? port : value;
  }
  if (["udp", "tls", "skip-cert-verify", "fast-open"].includes(key)) {
    return String(value).toLowerCase() === "true";
  }
  return value;
}

function parseSingboxJson(data: Record<string, unknown>): ProxyNode[] {
  const outbounds = Array.isArray(data.outbounds) ? data.outbounds : [];
  const nodes: ProxyNode[] = [];
  for (const outbound of outbounds) {
    if (!isRecord(outbound)) continue;
    const type = String(outbound.type || "");
    try {
      if (type === "vless") nodes.push(parseSingboxVless(outbound));
      if (type === "tuic") nodes.push(parseSingboxTuic(outbound));
      if (type === "hysteria2") nodes.push(parseSingboxHy2(outbound));
      if (type === "trojan") nodes.push(parseSingboxTrojan(outbound));
    } catch {
      // Ignore malformed individual outbounds.
    }
  }
  return nodes;
}

function parseSingboxVless(out: Record<string, unknown>): ProxyNode {
  const tls = isRecord(out.tls) ? out.tls : {};
  const reality = isRecord(tls.reality) ? tls.reality : {};
  const transport = isRecord(out.transport) ? out.transport : {};
  const node: ProxyNode = {
    name: String(out.tag || "undefined"),
    type: "vless",
    server: String(out.server || ""),
    port: Number(out.server_port || 0),
    uuid: String(out.uuid || ""),
    network: String(transport.type || "tcp"),
    udp: singboxAllowsUdp(out),
    tls: Boolean(tls.enabled),
  };
  if (node.tls) {
    node.servername = String(tls.server_name || "");
    if (Boolean(reality.enabled)) {
      node["client-fingerprint"] = getNestedString(tls, ["utls", "fingerprint"], "chrome");
      node["reality-opts"] = {
        "public-key": String(reality.public_key || ""),
        "short-id": String(reality.short_id || ""),
      };
    }
  }
  if (out.flow) node.flow = String(out.flow);
  return node;
}

function parseSingboxTuic(out: Record<string, unknown>): ProxyNode {
  const tls = isRecord(out.tls) ? out.tls : {};
  const node: ProxyNode = {
    name: String(out.tag || "undefined"),
    type: "tuic",
    server: String(out.server || ""),
    port: Number(out.server_port || 0),
    uuid: String(out.uuid || ""),
    password: String(out.password || ""),
    sni: String(tls.server_name || ""),
    "skip-cert-verify": Boolean(tls.insecure),
    "congestion-controller": String(out.congestion_control || "bbr"),
    "udp-relay-mode": "native",
  };
  if (Array.isArray(tls.alpn)) node.alpn = tls.alpn.map(String);
  return node;
}

function parseSingboxHy2(out: Record<string, unknown>): ProxyNode {
  const tls = isRecord(out.tls) ? out.tls : {};
  const obfs = isRecord(out.obfs) ? out.obfs : {};
  const node: ProxyNode = {
    name: String(out.tag || "undefined"),
    type: "hysteria2",
    server: String(out.server || ""),
    port: Number(out.server_port || 0),
    password: String(out.password || ""),
    alpn: Array.isArray(tls.alpn) ? tls.alpn.map(String) : ["h3"],
    ports: String(out.ports || "20000-50000"),
    "skip-cert-verify": Boolean(tls.insecure),
    udp: true,
    "fast-open": false,
  };
  if (tls.server_name) node.sni = String(tls.server_name);
  if (obfs.type) {
    node.obfs = String(obfs.type);
    node["obfs-password"] = String(obfs.password || "");
  }
  return node;
}

function parseSingboxTrojan(out: Record<string, unknown>): ProxyNode {
  const tls = isRecord(out.tls) ? out.tls : {};
  const transport = isRecord(out.transport) ? out.transport : {};
  const node: ProxyNode = {
    name: String(out.tag || "undefined"),
    type: "trojan",
    server: String(out.server || ""),
    port: Number(out.server_port || 0),
    password: String(out.password || ""),
    udp: singboxAllowsUdp(out),
    sni: String(tls.server_name || ""),
    "skip-cert-verify": Boolean(tls.insecure),
    network: String(transport.type || "tcp"),
  };
  if (Array.isArray(tls.alpn)) node.alpn = tls.alpn.map(String);
  const fingerprint = getNestedString(tls, ["utls", "fingerprint"], "");
  if (fingerprint) node["client-fingerprint"] = fingerprint;
  return node;
}

function singboxAllowsUdp(out: Record<string, unknown>): boolean {
  const network = out.network;
  if (!network) return out.udp_over_tcp !== false;
  const list = Array.isArray(network) ? network.map(String) : [String(network)];
  return list.includes("udp") && out.udp_over_tcp !== false;
}

function parseNodeUrl(line: string): ProxyNode | null {
  try {
    const parsed = new URL(line);
    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    const q = (key: string, fallback = "") => parsed.searchParams.get(key) || fallback;
    const alpn = parseAlpn(q("alpn"));
    const insecure = q("insecure") === "1" || q("allow_insecure") === "1";
    const name = decodeURIComponent(parsed.hash ? parsed.hash.slice(1) : "undefined") || "undefined";
    const node: ProxyNode = {
      name,
      server: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parsed.port ? Number(parsed.port) : undefined,
      type: scheme === "hy2" ? "hysteria2" : scheme,
    };

    if (scheme === "trojan") {
      node.password = decodeURIComponent(parsed.password || parsed.username || "");
      node.udp = !["0", "false"].includes(q("udp").toLowerCase());
      if (q("sni")) node.sni = q("sni");
      if (alpn) node.alpn = alpn;
      node["skip-cert-verify"] = insecure;
      if (q("fp")) node["client-fingerprint"] = q("fp");
      return node;
    }

    if (scheme === "hysteria2" || scheme === "hy2") {
      node.password = decodeURIComponent(parsed.password || parsed.username || "");
      node.alpn = alpn || ["h3"];
      node.ports = q("ports", "20000-50000");
      node["skip-cert-verify"] =
        insecure || q("skip-cert-verify") === "1" || q("skip_cert_verify") === "1";
      node.udp = true;
      const obfs = q("obfs") || q("obfs-type") || q("obfs_type");
      if (obfs && obfs !== "none") {
        node.obfs = obfs;
        node["obfs-password"] = q("obfs-password") || q("obfs_password");
      }
      node["fast-open"] = ["1", "true", "True"].includes(q("fast-open") || q("fastopen"));
      if (q("sni")) node.sni = q("sni");
      return node;
    }

    if (scheme === "vless") {
      node.uuid = decodeURIComponent(parsed.username || "");
      if (q("flow")) node.flow = q("flow");
      node.network = q("type", "tcp");
      node.udp = true;
      const security = q("security");
      if (security === "tls" || security === "reality") {
        node.tls = true;
        if (q("sni")) node.servername = q("sni");
        if (alpn) node.alpn = alpn;
        if (insecure) node["skip-cert-verify"] = true;
        if (q("fp")) node["client-fingerprint"] = q("fp");
        if (security === "reality") {
          node["reality-opts"] = {
            "public-key": q("pbk"),
            "short-id": q("sid"),
          };
        }
      }
      return node;
    }

    if (scheme === "tuic") {
      node.uuid = decodeURIComponent(parsed.username || "");
      node.password = decodeURIComponent(parsed.password || "");
      node["congestion-controller"] = q("congestion_control", "bbr");
      node["udp-relay-mode"] = "native";
      if (q("sni")) node.sni = q("sni");
      if (alpn) node.alpn = alpn;
      if (insecure) node["skip-cert-verify"] = true;
      return node;
    }
  } catch {
    return null;
  }
  return null;
}

function parseAlpn(value: string): string[] | null {
  if (!value) return null;
  return decodeURIComponent(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendIpv6Nodes(
  nodes: ProxyNode[],
  entries: ParsedNodeEntry[],
  mapping: Record<string, string[]>,
): AppendIpv6Result {
  const output = nodes.map((node) => ({ ...node }));
  const ipv6Entries: ParsedNodeEntry[] = [];
  for (const node of nodes) {
    if (!["tuic", "hysteria2"].includes(node.type)) continue;
    const candidates = mapping[node.server];
    if (!candidates || candidates.length === 0) continue;
    const ipv6 = candidates[Math.floor(Math.random() * candidates.length)];
    const clone = structuredClone(node) as ProxyNode;
    clone.name = `${node.name}-ipv6`;
    clone.server = ipv6;
    if (clone.type === "hysteria2") {
      clone.ports = "20000-50000";
    }
    output.push(clone);
    const sourceEntry = entries.find((entry) => entry.node === node);
    if (sourceEntry) {
      const shareLink = deriveIpv6ShareLink(sourceEntry.shareLink, clone.name, ipv6, clone.type);
      if (shareLink) {
        ipv6Entries.push({ node: clone, shareLink });
      }
    }
  }
  return { nodes: output, ipv6Entries };
}

function deriveIpv6ShareLink(sourceLink: string, nextName: string, ipv6: string, nodeType: string): string | null {
  try {
    const parsed = new URL(sourceLink);
    const port = parsed.port;
    if (!port) return null;
    parsed.host = `[${ipv6}]:${port}`;
    parsed.hash = encodeURIComponent(nextName);
    if (nodeType === "hysteria2") {
      parsed.searchParams.set("ports", "20000-50000");
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function dedupeNodeNames(nodes: ProxyNode[]): ProxyNode[] {
  const seen = new Set<string>();
  return nodes.map((node) => {
    const next = { ...node };
    const original = next.name || "undefined";
    let name = original;
    let index = 1;
    while (seen.has(name)) {
      name = `${original}_${index}`;
      index += 1;
    }
    seen.add(name);
    next.name = name;
    return normalizeNode(next);
  });
}

function normalizeNode(node: ProxyNode): ProxyNode {
  const clean = { ...node };
  if ("server_port" in clean && !clean.port) {
    clean.port = Number(clean.server_port);
    delete clean.server_port;
  }
  if (clean.type !== "vless") {
    delete clean.network;
  }
  for (const field of ["stack", "strict_route", "platform", "inbounds", "outbounds"]) {
    delete clean[field];
  }
  if (clean.type === "tuic") {
    delete clean.udp;
  }
  if (clean.type === "hysteria2") {
    const normalized: ProxyNode = {
      name: clean.name,
      type: "hysteria2",
      server: clean.server,
      port: Number(clean.port || 0),
      password: clean.password,
      alpn: Array.isArray(clean.alpn) ? clean.alpn : ["h3"],
      ports: String(clean.ports || "20000-50000"),
      "skip-cert-verify": Boolean(clean["skip-cert-verify"]),
      udp: true,
      "fast-open": Boolean(clean["fast-open"]),
    };
    if (clean.obfs) normalized.obfs = clean.obfs;
    if (clean["obfs-password"]) normalized["obfs-password"] = clean["obfs-password"];
    if (clean.sni) normalized.sni = clean.sni;
    return normalized;
  }
  return clean;
}

function sanitizeNode(node: ProxyNode): Record<string, unknown> {
  return {
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    network: node.network,
    sni: node.sni || node.servername,
  };
}

function buildShadowrocketBundle(links: string[], useBase64: boolean): ShadowrocketBundle {
  const rawText = links.join("\n");
  const text = useBase64 ? utf8ToBase64(rawText) : rawText;
  let qrDataUrl: string | null = null;
  let qrError: string | null = null;

  if (text) {
    try {
      const qr = qrcode(0, "L");
      qr.addData(text, "Byte");
      qr.make();
      const svg = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
      qrDataUrl = `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
    } catch {
      qrError = useBase64
        ? "节点链接过多，单个二维码容量不足；请复制 base64 文本导入。"
        : "节点链接过多，单个二维码容量不足；请复制节点链接文本导入。";
    }
  }

  return {
    text,
    qrDataUrl,
    qrError,
    linkCount: links.length,
    useBase64,
  };
}

function nodeToShareLink(node: ProxyNode): string | null {
  if (!node.server || !node.port) return null;
  if (node.type === "vless") return vlessShareLink(node);
  if (node.type === "trojan") return trojanShareLink(node);
  if (node.type === "hysteria2") return hysteria2ShareLink(node);
  if (node.type === "tuic") return tuicShareLink(node);
  return null;
}

function vlessShareLink(node: ProxyNode): string {
  const params = new URLSearchParams();
  params.set("type", String(node.network || "tcp"));
  const reality = isRecord(node["reality-opts"]) ? node["reality-opts"] : null;
  const security = reality ? "reality" : node.tls ? "tls" : "none";
  params.set("security", security);
  if (node.servername) params.set("sni", String(node.servername));
  if (node.flow) params.set("flow", String(node.flow));
  if (node["client-fingerprint"]) params.set("fp", String(node["client-fingerprint"]));
  if (Array.isArray(node.alpn) && node.alpn.length) params.set("alpn", node.alpn.map(String).join(","));
  if (node["skip-cert-verify"]) params.set("allow_insecure", "1");
  if (reality) {
    if (reality["public-key"]) params.set("pbk", String(reality["public-key"]));
    if (reality["short-id"]) params.set("sid", String(reality["short-id"]));
  }
  return `vless://${encodeURIComponent(String(node.uuid || ""))}@${formatShareHost(node.server)}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
}

function trojanShareLink(node: ProxyNode): string {
  const params = new URLSearchParams();
  params.set("security", "tls");
  if (node.sni) params.set("sni", String(node.sni));
  if (node["skip-cert-verify"]) params.set("allow_insecure", "1");
  if (node["client-fingerprint"]) params.set("fp", String(node["client-fingerprint"]));
  if (Array.isArray(node.alpn) && node.alpn.length) params.set("alpn", node.alpn.map(String).join(","));
  return `trojan://${encodeURIComponent(String(node.password || ""))}@${formatShareHost(node.server)}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
}

function hysteria2ShareLink(node: ProxyNode): string {
  const params = new URLSearchParams();
  if (node.sni) params.set("sni", String(node.sni));
  if (node["skip-cert-verify"]) params.set("insecure", "1");
  if (Array.isArray(node.alpn) && node.alpn.length) params.set("alpn", node.alpn.map(String).join(","));
  if (node.ports) params.set("ports", String(node.ports));
  if (node.obfs) params.set("obfs", String(node.obfs));
  if (node["obfs-password"]) params.set("obfs-password", String(node["obfs-password"]));
  if (node["fast-open"]) params.set("fast-open", "1");
  const query = params.toString();
  return `hysteria2://${encodeURIComponent(String(node.password || ""))}@${formatShareHost(node.server)}:${node.port}${query ? `?${query}` : ""}#${encodeURIComponent(node.name)}`;
}

function tuicShareLink(node: ProxyNode): string {
  const params = new URLSearchParams();
  params.set("congestion_control", String(node["congestion-controller"] || "bbr"));
  params.set("udp_relay_mode", String(node["udp-relay-mode"] || "native"));
  if (node.sni) params.set("sni", String(node.sni));
  if (node["skip-cert-verify"]) params.set("allow_insecure", "1");
  if (Array.isArray(node.alpn) && node.alpn.length) params.set("alpn", node.alpn.map(String).join(","));
  return `tuic://${encodeURIComponent(String(node.uuid || ""))}:${encodeURIComponent(String(node.password || ""))}@${formatShareHost(node.server)}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
}

function formatShareHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function generateYaml(template: string, nodes: ProxyNode[]): string {
  const proxyNames = nodes.map((node) => node.name);
  const withGroups = updateProxyGroups(template, proxyNames);
  return replaceRootBlock(withGroups, "proxies", serializeProxyList(nodes));
}

function extractRootBlock(template: string, key: string): string[] {
  const lines = normalizeNewlines(template).split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function replaceRootBlock(template: string, key: string, body: string): string {
  const lines = normalizeNewlines(template).split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start === -1) {
    return `${template.trimEnd()}\n\n${key}:\n${body}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), `${key}:`, ...body.split("\n"), ...lines.slice(end)].join("\n").trimEnd() + "\n";
}

function updateProxyGroups(template: string, newNodeNames: string[]): string {
  const lines = normalizeNewlines(template).split("\n");
  const start = lines.findIndex((line) => line === "proxy-groups:" || line.startsWith("proxy-groups: "));
  if (start === -1) return template;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const output = [...lines.slice(0, start)];
  const block = lines.slice(start, end);
  const groupNames = extractProxyGroupNames(block);
  for (let i = 0; i < block.length; i += 1) {
    const line = block[i];
    output.push(line);
    if (!/^    proxies:\s*$/.test(line)) {
      continue;
    }
    const existing: string[] = [];
    let j = i + 1;
    while (j < block.length && /^      -\s+/.test(block[j])) {
      existing.push(parseYamlScalar(block[j].replace(/^      -\s+/, "")));
      j += 1;
    }
    const keep = existing.filter((name) => isProxyGroupReference(name, groupNames));
    const merged = [...keep, ...newNodeNames];
    const deduped = [...new Set(merged)];
    for (const name of deduped) {
      output.push(`      - ${yamlScalar(name)}`);
    }
    i = j - 1;
  }

  output.push(...lines.slice(end));
  return output.join("\n");
}

function extractProxyGroupNames(block: string[]): Set<string> {
  const names = new Set<string>();
  for (const line of block) {
    const match = line.match(/^  -\s+name:\s*(.+?)\s*$/);
    if (match) names.add(parseYamlScalar(match[1]));
  }
  return names;
}

function isProxyGroupReference(name: string, groupNames: Set<string>): boolean {
  return groupNames.has(name) || ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"].includes(name);
}

function serializeProxyList(nodes: ProxyNode[]): string {
  return nodes.map((node) => serializeObjectAsListItem(node, 2)).join("\n");
}

function serializeObjectAsListItem(object: Record<string, unknown>, indent: number): string {
  const keys = orderedKeys(object);
  const lines: string[] = [];
  keys.forEach((key, index) => {
    appendYamlKey(lines, key, object[key], indent, index === 0 ? "- " : "  ");
  });
  return lines.join("\n");
}

function appendYamlKey(lines: string[], key: string, value: unknown, indent: number, prefix: string): void {
  const base = " ".repeat(indent) + prefix;
  if (Array.isArray(value)) {
    lines.push(`${base}${key}:`);
    for (const item of value) {
      lines.push(`${" ".repeat(indent + prefix.length + 2)}- ${yamlScalar(item)}`);
    }
    return;
  }
  if (isRecord(value)) {
    lines.push(`${base}${key}:`);
    for (const childKey of orderedKeys(value)) {
      appendYamlKey(lines, childKey, value[childKey], indent + prefix.length + 2, "");
    }
    return;
  }
  if (value === undefined || value === null || value === "") {
    return;
  }
  lines.push(`${base}${key}: ${yamlScalar(value)}`);
}

function orderedKeys(object: Record<string, unknown>): string[] {
  const order = [
    "name",
    "type",
    "server",
    "port",
    "uuid",
    "password",
    "network",
    "udp",
    "tls",
    "servername",
    "sni",
    "flow",
    "packet-encoding",
    "client-fingerprint",
    "skip-cert-verify",
    "congestion-controller",
    "udp-relay-mode",
    "alpn",
    "ports",
    "obfs",
    "obfs-password",
    "fast-open",
    "reality-opts",
  ];
  return [...order.filter((key) => key in object), ...Object.keys(object).filter((key) => !order.includes(key))];
}

function yamlScalar(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  if (!text) return '""';
  if (
    /(^\s|\s$|[:#,[\]{}&*!|>'"%@`])/.test(text) ||
    /^(true|false|null|yes|no|on|off|[-+]?\d+(\.\d+)?)$/i.test(text)
  ) {
    return JSON.stringify(text);
  }
  return text;
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeDisplayTable(value: unknown): DisplayTable {
  if (!isRecord(value)) return DEFAULT_TABLE;
  const columns = Array.isArray(value.columns) ? value.columns.map((item) => String(item).trim()) : [];
  const safeColumns = columns.length ? columns.slice(0, 30) : DEFAULT_TABLE.columns;
  const rows = Array.isArray(value.rows) ? value.rows : [];
  return {
    columns: safeColumns,
    rows: rows.slice(0, 200).map((row) => {
      const record = isRecord(row) ? row : {};
      const cells = Array.isArray(record.cells) ? record.cells.map((item) => String(item)) : [];
      return {
        name: String(record.name || ""),
        cells: safeColumns.map((_, index) => cells[index] || ""),
      };
    }),
  };
}

function normalizeIpv6Mapping(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new HttpError(400, "IPv6 映射必须是 JSON 对象");
  }
  const mapping: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list)) {
      throw new HttpError(400, `映射 ${key} 必须是数组`);
    }
    const values = list.map((item) => String(item).trim()).filter(Boolean);
    if (values.length) mapping[key.trim()] = values;
  }
  return mapping;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${label}不能为空`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolField(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function numberField(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedString(record: Record<string, unknown>, path: string[], fallback: string): string {
  let current: unknown = record;
  for (const item of path) {
    if (!isRecord(current)) return fallback;
    current = current[item];
  }
  return typeof current === "string" ? current : fallback;
}

function decodeBase64Utf8(input: string): string {
  const compact = input.trim().replace(/\s+/g, "");
  if (!compact) {
    throw new Error("empty base64");
  }
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100000) {
    return false;
  }
  const salt = base64ToBytes(parts[2]);
  const expected = parts[3];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    key,
    256,
  );
  return constantTimeEqual(bytesToBase64(new Uint8Array(bits)), expected);
}

function randomToken(): string {
  return bytesToBase64(randomBytes(32)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "请求 JSON 无效");
  }
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const APP_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>订阅面板</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-2: #eef2f6;
      --text: #1f2933;
      --muted: #637083;
      --line: #d8dee8;
      --accent: #116a7b;
      --accent-strong: #0b5563;
      --danger: #b42318;
      --ok: #147a3d;
      --shadow: 0 10px 28px rgba(31, 41, 51, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    button, input, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--text);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button.primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    button.primary:hover { background: var(--accent-strong); }
    button.danger { color: var(--danger); border-color: #f1b4ad; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      padding: 9px 10px;
      outline: none;
    }
    textarea {
      min-height: 160px;
      resize: vertical;
      line-height: 1.5;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 9px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 700;
      background: var(--surface-2);
    }
    .login {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .login-panel {
      width: min(420px, 100%);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 22px;
    }
    .login-panel h1 {
      margin: 0 0 18px;
      font-size: 24px;
      letter-spacing: 0;
    }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .topbar {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    .brand {
      font-size: 18px;
      font-weight: 800;
    }
    .userbar {
      display: flex;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      min-height: 0;
    }
    .nav {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      padding: 14px;
    }
    .nav button {
      width: 100%;
      text-align: left;
      margin-bottom: 8px;
    }
    .nav button.active {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .content {
      padding: 18px;
      min-width: 0;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 16px;
      margin-bottom: 16px;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 12px;
    }
    .message {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: pre-wrap;
    }
    .error { color: var(--danger); }
    .ok { color: var(--ok); }
    .readonly-text {
      white-space: pre-wrap;
      line-height: 1.6;
      color: var(--text);
    }
    .table-scroll {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .table-scroll table th, .table-scroll table td {
      min-width: 120px;
    }
    .inline-check {
      width: auto;
      margin-right: 6px;
    }
    .compact-input {
      min-width: 120px;
      padding: 7px 8px;
      font-size: 13px;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
    }
    @media (max-width: 760px) {
      .layout { grid-template-columns: 1fr; }
      .nav {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .nav button {
        width: auto;
        white-space: nowrap;
        margin-bottom: 0;
      }
      .grid, .split { grid-template-columns: 1fr; }
      .topbar { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    var state = {
      user: null,
      content: null,
      activeTab: "generate",
      message: "",
      error: "",
      yaml: "",
      nodeCount: 0,
      sources: [],
      shadowrocketText: "",
      shadowrocketQrDataUrl: "",
      shadowrocketQrError: "",
      shadowrocketLinkCount: 0,
      shadowrocketUseBase64: false,
      admin: {
        users: [],
        prefixes: [],
        mappingText: "{}",
        contentText: "",
        contentTable: { columns: [], rows: [] },
        shadowrocketUseBase64: false
      }
    };

    var root = document.getElementById("app");

    function esc(value) {
      return String(value == null ? "" : value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    async function api(path, options) {
      var init = options || {};
      init.credentials = "include";
      init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
      var response = await fetch(path, init);
      var text = await response.text();
      var data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(data.error || "请求失败");
      }
      return data;
    }

    async function init() {
      try {
        var data = await api("/api/me");
        state.user = data.user;
        state.content = data.content;
        await loadAdminData();
      } catch (error) {
        state.user = null;
      }
      render();
    }

    function render() {
      if (!state.user) {
        root.innerHTML = renderLogin();
        bindLogin();
        return;
      }
      root.innerHTML = renderApp();
      bindApp();
    }

    function renderLogin() {
      return [
        '<main class="login">',
        '<section class="login-panel">',
        '<h1>订阅面板</h1>',
        '<form id="loginForm">',
        '<label>用户名<input name="username" autocomplete="username"></label><br>',
        '<label>密码<input name="password" type="password" autocomplete="current-password"></label>',
        '<div class="actions"><button class="primary" type="submit">登录</button></div>',
        '<div id="loginMsg" class="message error"></div>',
        '</form>',
        '</section>',
        '</main>'
      ].join("");
    }

    function renderApp() {
      return [
        '<div class="app">',
        '<header class="topbar">',
        '<div class="brand">订阅面板</div>',
        '<div class="userbar"><span>' + esc(state.user.username) + '</span><button id="logoutBtn">退出</button></div>',
        '</header>',
        '<div class="layout">',
        renderNav(),
        '<main class="content">',
        renderMessage(),
        renderActiveTab(),
        '</main>',
        '</div>',
        '</div>'
      ].join("");
    }

    function renderNav() {
      var tabs = [
        ["generate", "生成订阅"],
        ["nodes", "节点展示"]
      ];
      if (state.user.isAdmin) {
        tabs.push(["users", "用户"]);
        tabs.push(["content", "展示内容"]);
        tabs.push(["ipv6", "IPv6 映射"]);
        tabs.push(["prefixes", "订阅前缀"]);
      }
      return '<nav class="nav">' + tabs.map(function(tab) {
        return '<button data-tab="' + tab[0] + '" class="' + (state.activeTab === tab[0] ? "active" : "") + '">' + tab[1] + '</button>';
      }).join("") + '</nav>';
    }

    function renderMessage() {
      if (state.error) return '<div class="panel message error">' + esc(state.error) + '</div>';
      if (state.message) return '<div class="panel message ok">' + esc(state.message) + '</div>';
      return "";
    }

    function renderActiveTab() {
      if (state.activeTab === "nodes") return renderNodesTab();
      if (state.activeTab === "users") return renderUsersTab();
      if (state.activeTab === "content") return renderContentTab();
      if (state.activeTab === "ipv6") return renderIpv6Tab();
      if (state.activeTab === "prefixes") return renderPrefixesTab();
      return renderGenerateTab();
    }

    function renderGenerateTab() {
      var sources = state.sources.map(function(item) {
        return '<tr><td>' + esc(item.name) + '</td><td>' + (item.ok ? '<span class="ok">成功</span>' : '<span class="error">失败</span>') + '</td><td>' + esc(item.nodes) + '</td><td>' + esc(item.error || "") + '</td></tr>';
      }).join("");
      var sourceHead = '<tr><th>名称</th><th>状态</th><th>节点数</th><th>错误</th></tr>';
      return [
        '<section class="panel">',
        '<h2>生成订阅</h2>',
        '<div class="actions">',
        '<button id="generateBtn" class="primary">生成订阅文件</button>',
        state.yaml ? '<button id="downloadBtn">下载 YAML</button><button id="copyBtn">复制 YAML</button><button id="copyShadowrocketBtn">复制小火箭文本</button>' : '',
        '</div>',
        '</section>',
        state.sources.length ? '<section class="panel"><h2>订阅源</h2><div class="table-scroll"><table><thead>' + sourceHead + '</thead><tbody>' + sources + '</tbody></table></div></section>' : '',
        state.shadowrocketText ? '<section class="panel"><h2>小火箭</h2>' + (state.shadowrocketQrDataUrl ? '<img alt="小火箭二维码" src="' + esc(state.shadowrocketQrDataUrl) + '" style="width: min(260px, 100%); height: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 8px;">' : '') + (state.shadowrocketQrError ? '<div class="message error">' + esc(state.shadowrocketQrError) + '</div>' : '') + '<div class="message">已合并 ' + esc(state.shadowrocketLinkCount) + ' 个节点链接，当前模式：' + (state.shadowrocketUseBase64 ? 'Base64' : '原始链接') + '。</div><textarea id="shadowrocketBox" readonly>' + esc(state.shadowrocketText) + '</textarea></section>' : '',
        state.yaml ? '<section class="panel"><h2>YAML</h2><textarea id="yamlBox" readonly>' + esc(state.yaml) + '</textarea></section>' : ''
      ].join("");
    }

    function renderNodesTab() {
      return [
        '<section class="panel">',
        '<h2>节点文字</h2>',
        '<div class="readonly-text">' + esc(state.content && state.content.text ? state.content.text : "") + '</div>',
        '</section>',
        '<section class="panel">',
        '<h2>节点表格</h2>',
        renderReadonlyTable(state.content ? state.content.table : { columns: [], rows: [] }),
        '</section>'
      ].join("");
    }

    function renderReadonlyTable(table) {
      var columns = table.columns || [];
      var rows = table.rows || [];
      var head = '<th>节点</th>' + columns.map(function(col) { return '<th>' + esc(col) + '</th>'; }).join("");
      var body = rows.map(function(row) {
        return '<tr><td>' + esc(row.name) + '</td>' + columns.map(function(_, index) {
          return '<td>' + esc((row.cells || [])[index] || "") + '</td>';
        }).join("") + '</tr>';
      }).join("");
      return '<div class="table-scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }

    function renderUsersTab() {
      var rows = state.admin.users.map(function(user) {
        return [
          '<tr data-user-id="' + user.id + '">',
          '<td>' + user.id + '</td>',
          '<td><input class="compact-input user-username" value="' + esc(user.username) + '"></td>',
          '<td><input class="compact-input user-sub" value="' + esc(user.subscription_username || "") + '"></td>',
          '<td><input class="compact-input user-password" type="password" placeholder="留空不改"></td>',
          '<td><input class="inline-check user-admin" type="checkbox" ' + (user.is_admin ? "checked" : "") + '></td>',
          '<td><input class="inline-check user-active" type="checkbox" ' + (user.is_active ? "checked" : "") + '></td>',
          '<td><button class="save-user">保存</button> <button class="danger delete-user">删除</button></td>',
          '</tr>'
        ].join("");
      }).join("");
      return [
        '<section class="panel">',
        '<h2>注册新用户</h2>',
        '<div class="grid">',
        '<label>用户名<input id="newUsername"></label>',
        '<label>订阅用户名<input id="newSubUsername"></label>',
        '<label>密码<input id="newPassword" type="password"></label>',
        '<label>管理员 <span><input id="newIsAdmin" class="inline-check" type="checkbox">是</span></label>',
        '</div>',
        '<div class="actions"><button id="createUserBtn" class="primary">创建用户</button></div>',
        '</section>',
        '<section class="panel">',
        '<h2>用户列表</h2>',
        '<div class="table-scroll"><table><thead><tr><th>ID</th><th>用户名</th><th>订阅用户名</th><th>新密码</th><th>管理员</th><th>启用</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>',
        '</section>'
      ].join("");
    }

    function renderContentTab() {
      return [
        '<section class="panel">',
        '<h2>小火箭输出</h2>',
        '<label><span><input id="shadowrocketUseBase64" class="inline-check" type="checkbox" ' + (state.admin.shadowrocketUseBase64 ? "checked" : "") + '>使用 Base64 编码生成二维码和复制文本</span></label>',
        '</section>',
        '<section class="panel">',
        '<h2>文字区域</h2>',
        '<textarea id="contentText">' + esc(state.admin.contentText) + '</textarea>',
        '</section>',
        '<section class="panel">',
        '<h2>表格区域</h2>',
        renderEditableTable(),
        '<div class="actions">',
        '<button id="addColumnBtn">添加列</button>',
        '<button id="addRowBtn">添加行</button>',
        '<button id="saveContentBtn" class="primary">保存展示内容</button>',
        '</div>',
        '</section>'
      ].join("");
    }

    function renderEditableTable() {
      var table = state.admin.contentTable || { columns: [], rows: [] };
      var columns = table.columns || [];
      var rows = table.rows || [];
      var head = '<th>行名称</th>' + columns.map(function(col, index) {
        return '<th><input class="compact-input col-name" data-col="' + index + '" value="' + esc(col) + '"><button class="danger remove-col" data-col="' + index + '">删除列</button></th>';
      }).join("") + '<th></th>';
      var body = rows.map(function(row, rowIndex) {
        var cells = columns.map(function(_, colIndex) {
          return '<td><input class="compact-input cell-value" data-row="' + rowIndex + '" data-col="' + colIndex + '" value="' + esc((row.cells || [])[colIndex] || "") + '"></td>';
        }).join("");
        return '<tr><td><input class="compact-input row-name" data-row="' + rowIndex + '" value="' + esc(row.name || "") + '"></td>' + cells + '<td><button class="danger remove-row" data-row="' + rowIndex + '">删除行</button></td></tr>';
      }).join("");
      return '<div class="table-scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }

    function renderIpv6Tab() {
      return [
        '<section class="panel">',
        '<h2>IPv6 映射表</h2>',
        '<textarea id="mappingText">' + esc(state.admin.mappingText) + '</textarea>',
        '<div class="actions"><button id="saveMappingBtn" class="primary">保存 IPv6 映射</button></div>',
        '</section>'
      ].join("");
    }

    function renderPrefixesTab() {
      var rows = state.admin.prefixes.map(function(prefix) {
        return [
          '<tr data-prefix-id="' + prefix.id + '">',
          '<td><input class="compact-input prefix-name" value="' + esc(prefix.name) + '"></td>',
          '<td><input class="compact-input prefix-url" value="' + esc(prefix.url_prefix) + '"></td>',
          '<td><input class="compact-input prefix-sort" type="number" value="' + esc(prefix.sort_order) + '"></td>',
          '<td><input class="inline-check prefix-enabled" type="checkbox" ' + (prefix.enabled ? "checked" : "") + '></td>',
          '<td><button class="save-prefix">保存</button> <button class="danger delete-prefix">删除</button></td>',
          '</tr>'
        ].join("");
      }).join("");
      return [
        '<section class="panel">',
        '<h2>新增前缀</h2>',
        '<div class="grid">',
        '<label>名称<input id="newPrefixName"></label>',
        '<label>前缀<input id="newPrefixUrl" placeholder="https://example.com/sub/"></label>',
        '<label>排序<input id="newPrefixSort" type="number" value="0"></label>',
        '<label>启用 <span><input id="newPrefixEnabled" class="inline-check" type="checkbox" checked>是</span></label>',
        '</div>',
        '<div class="actions"><button id="createPrefixBtn" class="primary">创建前缀</button></div>',
        '</section>',
        '<section class="panel">',
        '<h2>前缀列表</h2>',
        '<div class="table-scroll"><table><thead><tr><th>名称</th><th>前缀</th><th>排序</th><th>启用</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>',
        '</section>'
      ].join("");
    }

    function bindLogin() {
      document.getElementById("loginForm").addEventListener("submit", async function(event) {
        event.preventDefault();
        var form = new FormData(event.currentTarget);
        try {
          var data = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
          });
          state.user = data.user;
          state.error = "";
          await loadAdminData();
          var me = await api("/api/me");
          state.content = me.content;
          render();
        } catch (error) {
          document.getElementById("loginMsg").textContent = error.message;
        }
      });
    }

    function bindApp() {
      document.getElementById("logoutBtn").addEventListener("click", async function() {
        await api("/api/logout", { method: "POST", body: "{}" });
        state.user = null;
        render();
      });

      document.querySelectorAll("[data-tab]").forEach(function(button) {
        button.addEventListener("click", function() {
          state.activeTab = button.getAttribute("data-tab");
          state.message = "";
          state.error = "";
          render();
        });
      });

      var generateBtn = document.getElementById("generateBtn");
      if (generateBtn) generateBtn.addEventListener("click", generateSubscription);
      var downloadBtn = document.getElementById("downloadBtn");
      if (downloadBtn) downloadBtn.addEventListener("click", downloadYaml);
      var copyBtn = document.getElementById("copyBtn");
      if (copyBtn) copyBtn.addEventListener("click", copyYaml);
      var copyShadowrocketBtn = document.getElementById("copyShadowrocketBtn");
      if (copyShadowrocketBtn) copyShadowrocketBtn.addEventListener("click", copyShadowrocket);

      bindUsers();
      bindContent();
      bindIpv6();
      bindPrefixes();
    }

    async function loadAdminData() {
      if (!state.user || !state.user.isAdmin) return;
      var users = await api("/api/admin/users");
      var content = await api("/api/admin/content");
      var mapping = await api("/api/admin/ipv6-mappings");
      var prefixes = await api("/api/admin/prefixes");
      state.admin.users = users.users;
      state.admin.contentText = content.text;
      state.admin.contentTable = content.table;
      state.admin.shadowrocketUseBase64 = !!content.shadowrocketUseBase64;
      state.admin.mappingText = JSON.stringify(mapping.mapping, null, 2);
      state.admin.prefixes = prefixes.prefixes;
    }

    async function refreshMe() {
      var data = await api("/api/me");
      state.user = data.user;
      state.content = data.content;
    }

    async function generateSubscription() {
      setBusy("generateBtn", true);
      state.error = "";
      state.message = "正在生成订阅文件...";
      render();
      try {
        var data = await api("/api/generate", { method: "POST", body: "{}" });
        state.yaml = data.yaml;
        state.nodeCount = data.nodeCount;
        state.sources = data.sources;
        state.shadowrocketText = data.shadowrocketText || "";
        state.shadowrocketQrDataUrl = data.shadowrocketQrDataUrl || "";
        state.shadowrocketQrError = data.shadowrocketQrError || "";
        state.shadowrocketLinkCount = data.shadowrocketLinkCount || 0;
        state.shadowrocketUseBase64 = !!data.shadowrocketUseBase64;
        state.message = "订阅已生成，共 " + data.nodeCount + " 个节点。";
      } catch (error) {
        state.error = error.message;
        state.message = "";
      }
      render();
    }

    function downloadYaml() {
      var blob = new Blob([state.yaml], { type: "text/yaml;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "subscription.yaml";
      link.click();
      URL.revokeObjectURL(url);
    }

    async function writeClipboardText(text) {
      if (!text) throw new Error("没有可复制的内容。");
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch (error) {
          // Fall back below for HTTP/IP access or stricter browser settings.
        }
      }

      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      var copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!copied) {
        throw new Error("浏览器阻止了自动复制，请手动选中文本复制。");
      }
    }

    async function copyYaml() {
      try {
        await writeClipboardText(state.yaml);
        state.message = "YAML 已复制。";
        state.error = "";
      } catch (error) {
        state.error = error.message;
      }
      render();
    }

    async function copyShadowrocket() {
      try {
        await writeClipboardText(state.shadowrocketText || "");
        state.message = state.shadowrocketUseBase64 ? "小火箭 Base64 已复制。" : "节点链接已复制。";
        state.error = "";
      } catch (error) {
        state.error = error.message;
      }
      render();
    }

    function bindUsers() {
      var createBtn = document.getElementById("createUserBtn");
      if (createBtn) createBtn.addEventListener("click", async function() {
        try {
          await api("/api/admin/users", {
            method: "POST",
            body: JSON.stringify({
              username: document.getElementById("newUsername").value,
              subscriptionUsername: document.getElementById("newSubUsername").value,
              password: document.getElementById("newPassword").value,
              isAdmin: document.getElementById("newIsAdmin").checked,
              isActive: true
            })
          });
          state.message = "用户已创建。";
          await loadAdminData();
          render();
        } catch (error) {
          state.error = error.message;
          render();
        }
      });

      document.querySelectorAll(".save-user").forEach(function(button) {
        button.addEventListener("click", async function() {
          var row = button.closest("tr");
          var id = row.getAttribute("data-user-id");
          var password = row.querySelector(".user-password").value;
          var payload = {
            username: row.querySelector(".user-username").value,
            subscriptionUsername: row.querySelector(".user-sub").value,
            isAdmin: row.querySelector(".user-admin").checked,
            isActive: row.querySelector(".user-active").checked
          };
          if (password) payload.password = password;
          try {
            await api("/api/admin/users/" + id, { method: "PATCH", body: JSON.stringify(payload) });
            state.message = "用户已保存。";
            await loadAdminData();
            render();
          } catch (error) {
            state.error = error.message;
            render();
          }
        });
      });

      document.querySelectorAll(".delete-user").forEach(function(button) {
        button.addEventListener("click", async function() {
          if (!confirm("确认删除这个用户？")) return;
          var id = button.closest("tr").getAttribute("data-user-id");
          try {
            await api("/api/admin/users/" + id, { method: "DELETE" });
            state.message = "用户已删除。";
            await loadAdminData();
            render();
          } catch (error) {
            state.error = error.message;
            render();
          }
        });
      });
    }

    function bindContent() {
      var addColumnBtn = document.getElementById("addColumnBtn");
      if (addColumnBtn) addColumnBtn.addEventListener("click", function() {
        syncEditableTable();
        state.admin.contentTable.columns.push("新列");
        state.admin.contentTable.rows.forEach(function(row) { row.cells.push(""); });
        render();
      });

      var addRowBtn = document.getElementById("addRowBtn");
      if (addRowBtn) addRowBtn.addEventListener("click", function() {
        syncEditableTable();
        state.admin.contentTable.rows.push({ name: "新行", cells: state.admin.contentTable.columns.map(function() { return ""; }) });
        render();
      });

      document.querySelectorAll(".remove-col").forEach(function(button) {
        button.addEventListener("click", function() {
          syncEditableTable();
          var index = Number(button.getAttribute("data-col"));
          state.admin.contentTable.columns.splice(index, 1);
          state.admin.contentTable.rows.forEach(function(row) { row.cells.splice(index, 1); });
          render();
        });
      });

      document.querySelectorAll(".remove-row").forEach(function(button) {
        button.addEventListener("click", function() {
          syncEditableTable();
          state.admin.contentTable.rows.splice(Number(button.getAttribute("data-row")), 1);
          render();
        });
      });

      var saveContentBtn = document.getElementById("saveContentBtn");
      if (saveContentBtn) saveContentBtn.addEventListener("click", async function() {
        syncEditableTable();
        try {
          var data = await api("/api/admin/content", {
            method: "PUT",
            body: JSON.stringify({
              text: document.getElementById("contentText").value,
              table: state.admin.contentTable,
              shadowrocketUseBase64: state.admin.shadowrocketUseBase64
            })
          });
          state.content = data;
          state.admin.contentText = data.text;
          state.admin.contentTable = data.table;
          state.admin.shadowrocketUseBase64 = !!data.shadowrocketUseBase64;
          state.message = "展示内容已保存。";
          render();
        } catch (error) {
          state.error = error.message;
          render();
        }
      });
    }

    function syncEditableTable() {
      var text = document.getElementById("contentText");
      if (text) state.admin.contentText = text.value;
      var useBase64 = document.getElementById("shadowrocketUseBase64");
      if (useBase64) state.admin.shadowrocketUseBase64 = useBase64.checked;
      document.querySelectorAll(".col-name").forEach(function(input) {
        state.admin.contentTable.columns[Number(input.getAttribute("data-col"))] = input.value;
      });
      document.querySelectorAll(".row-name").forEach(function(input) {
        state.admin.contentTable.rows[Number(input.getAttribute("data-row"))].name = input.value;
      });
      document.querySelectorAll(".cell-value").forEach(function(input) {
        var row = Number(input.getAttribute("data-row"));
        var col = Number(input.getAttribute("data-col"));
        state.admin.contentTable.rows[row].cells[col] = input.value;
      });
    }

    function bindIpv6() {
      var saveMappingBtn = document.getElementById("saveMappingBtn");
      if (!saveMappingBtn) return;
      saveMappingBtn.addEventListener("click", async function() {
        try {
          var mapping = JSON.parse(document.getElementById("mappingText").value);
          var data = await api("/api/admin/ipv6-mappings", { method: "PUT", body: JSON.stringify({ mapping: mapping }) });
          state.admin.mappingText = JSON.stringify(data.mapping, null, 2);
          state.message = "IPv6 映射已保存。";
          render();
        } catch (error) {
          state.error = error.message;
          render();
        }
      });
    }

    function bindPrefixes() {
      var createBtn = document.getElementById("createPrefixBtn");
      if (createBtn) createBtn.addEventListener("click", async function() {
        try {
          await api("/api/admin/prefixes", {
            method: "POST",
            body: JSON.stringify({
              name: document.getElementById("newPrefixName").value,
              urlPrefix: document.getElementById("newPrefixUrl").value,
              sortOrder: Number(document.getElementById("newPrefixSort").value || 0),
              enabled: document.getElementById("newPrefixEnabled").checked
            })
          });
          state.message = "前缀已创建。";
          await loadAdminData();
          render();
        } catch (error) {
          state.error = error.message;
          render();
        }
      });

      document.querySelectorAll(".save-prefix").forEach(function(button) {
        button.addEventListener("click", async function() {
          var row = button.closest("tr");
          var id = row.getAttribute("data-prefix-id");
          try {
            await api("/api/admin/prefixes/" + id, {
              method: "PATCH",
              body: JSON.stringify({
                name: row.querySelector(".prefix-name").value,
                urlPrefix: row.querySelector(".prefix-url").value,
                sortOrder: Number(row.querySelector(".prefix-sort").value || 0),
                enabled: row.querySelector(".prefix-enabled").checked
              })
            });
            state.message = "前缀已保存。";
            await loadAdminData();
            render();
          } catch (error) {
            state.error = error.message;
            render();
          }
        });
      });

      document.querySelectorAll(".delete-prefix").forEach(function(button) {
        button.addEventListener("click", async function() {
          if (!confirm("确认删除这个前缀？")) return;
          var id = button.closest("tr").getAttribute("data-prefix-id");
          try {
            await api("/api/admin/prefixes/" + id, { method: "DELETE" });
            state.message = "前缀已删除。";
            await loadAdminData();
            render();
          } catch (error) {
            state.error = error.message;
            render();
          }
        });
      });
    }

    function setBusy(id, busy) {
      var button = document.getElementById(id);
      if (button) button.disabled = busy;
    }

    init();
  </script>
</body>
</html>`;
