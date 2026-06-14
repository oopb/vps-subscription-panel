# Cloudflare Workers 部署说明

这个目录是 TypeScript 版订阅面板，使用 Cloudflare Worker + D1。

## 功能结构

- 前端页面由 Worker 直接返回，不需要单独的 Pages 构建。
- D1 保存用户、登录会话、展示文字、展示表格、IPv6 映射、VPS 订阅前缀。
- `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 只用于首次创建管理员：当 D1 里没有任何用户时，Worker 会自动创建第一个管理员。
- 订阅链接生成规则：如果前缀里包含 `{username}`，会替换成用户的订阅用户名；否则使用 `前缀 + 订阅用户名`。

## 1. 安装依赖

```bash
cd worker
npm install
```

## 2. 登录 Cloudflare

```bash
npx wrangler login
```

## 3. 创建 D1 数据库

```bash
npx wrangler d1 create vps_subscription_db
```

命令会输出类似：

```toml
[[d1_databases]]
binding = "DB"
database_name = "vps_subscription_db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把输出里的 `database_id` 填到 `wrangler.toml`，替换：

```toml
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

## 4. 配置首次管理员

有两种方式，二选一即可。

### 方式 A：用 Cloudflare Secret 自动创建

远程环境用 Wrangler Secrets：

```bash
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
```

建议首次登录后立刻在后台修改管理员密码。D1 已经有管理员后，这两个 Secret 不会再覆盖现有账号；确认账号可用后，也可以在 Cloudflare 控制台删除或轮换 `ADMIN_PASSWORD`。

### 方式 B：直接写入 D1 管理员账号

如果不想配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，可以本地生成管理员 SQL：

```bash
npm run admin:sql -- admin your-strong-password
```

把输出的 SQL 复制到 Cloudflare D1 Console 执行。密码会以 PBKDF2-SHA256 加盐哈希写入 `users.password_hash`，不是明文；迭代次数使用 Cloudflare Workers WebCrypto 支持的 `100000`。

本地开发可以复制示例：

```bash
copy .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars`。这个文件已被 `.gitignore` 忽略。

## 5. 执行数据库迁移

本地：

```bash
npm run db:migrate:local
```

远程：

```bash
npm run db:migrate
```

迁移会创建这些表：

- `users`：用户和管理员账号
- `sessions`：登录会话
- `settings`：展示文字、展示表格、IPv6 映射
- `subscription_prefixes`：订阅链接前缀

## 6. 本地运行

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:8787
```

如果使用本仓库附带的本地测试 `.dev.vars`，默认账号是：

```text
admin / admin123456
```

## 7. 部署

```bash
npm run deploy
```

部署成功后，Wrangler 会输出 `workers.dev` 地址。也可以在 Cloudflare 控制台给这个 Worker 绑定自定义域名。

## 8. 后台配置顺序

1. 用首次管理员登录。
2. 进入“用户”，修改管理员密码，创建普通用户。
3. 进入“订阅前缀”，添加 VPS 订阅链接前缀。
4. 进入“IPv6 映射”，维护 IPv4 到 IPv6 数组的 JSON。
5. 进入“展示内容”，编辑文字区域和表格区域。
6. 普通用户登录后点击“生成订阅文件”即可生成 YAML。

## 9. 订阅前缀示例

直接拼接：

```text
https://example.com/sub/
```

用户订阅用户名是 `alice` 时，最终请求：

```text
https://example.com/sub/alice
```

占位符：

```text
https://example.com/api/sub?user={username}
```

用户订阅用户名是 `alice` 时，最终请求：

```text
https://example.com/api/sub?user=alice
```

## 10. 模板

Worker 使用 `template.yaml` 作为 Clash/Mihomo 模板。它来自根目录的 `example.yaml`，部署时会一起打包。需要调整规则、DNS、proxy-groups 时，编辑 `worker/template.yaml`。
