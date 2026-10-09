# 004 API key 与鉴权对齐方案（M5）

> **历史文档**：M5 的方案记录，保留原文不改写。当前形态以 README 为准。

## 1. 背景与目标

M0–M3 让控制面在资源面上兼容 `console.neon.tech/api/v2` 子集，但它没有对齐 Neon 的**鉴权与 API key 管理面**：

- 鉴权是"单把全局 key，`api_keys` 表为空时完全放行"；
- key 只能用 `scripts/create-api-key.mjs` 直接写库，没有 HTTP 管理接口；
- 没有个人/组织/项目 scoped key 的区分，没有 `created_by`、`last_used_from_addr`、撤销；
- 没有 `/auth`、`/users/me`、`/organizations` 身份面，控制台也没有登录。

M5 的目标是把这些补齐，并以官方 vendored spec（`spec/neon-api-v2.json`）为准做响应校验，使 `neonctl` 与真实 `provider-neon` 之外的通用 Neon 客户端也能工作。

**对齐范围（2026-09-10 用户定案）**：Phase 1（Key 管理 API）+ Phase 2（身份面）+ Phase 3（控制台 UI/会话）；id/token 严格对齐（整数 id + `napi_` 前缀）；建 `users/organizations/members` 表；去掉"空表放行"改为强制鉴权 + 首次引导；强制 project-scoped key 只能访问其项目。控制台支持三种登录：本地邮箱密码、一键 dev 登录、通用 OIDC。

## 2. 官方契约要点

- 安全方案（每个端点都声明）：`BearerAuth`（API key）、`CookieAuth`（cookie `zenith`）、`TokenCookieAuth`（cookie `keycloak_token`）。
- key 端点：`GET/POST /api_keys`、`DELETE /api_keys/{key_id}`、`GET/POST /organizations/{org_id}/api_keys`、`DELETE /organizations/{org_id}/api_keys/{key_id}`。
- 身份端点：`GET /auth`（`auth_method: keycloak|session_cookie|api_key_user|api_key_org|oauth`）、`GET /users/me`、`GET /users/me/organizations`、`GET /organizations/{org_id}`、`GET /organizations/{org_id}/members`、`GET/PATCH/DELETE /organizations/{org_id}/members/{member_id}`。
- 形状不一致必须照抄：创建/撤销响应的 `created_by` 是 uuid 字符串，列表项的是对象 `{id,name,image}`；`last_used_from_addr` 为必填字符串。
- 语义：token 只在创建时返回一次，库里只存摘要；个人 key 默认可访问所属组织项目，组织 key 为该组织 admin 级，project-scoped key 只能访问绑定项目；只有组织 `admin` 能建组织/项目 key；`MemberRole` 为 `admin|member|editor|viewer|collaborator`。

## 3. 数据模型（迁移 `0002_identity_keys.sql`）

- `users(id uuid, email, name, last_name, image, password_hash, ...)`
- `organizations(id slug, name, handle, plan, managed_by, ...)`
- `members(id uuid, org_id, user_id, role, joined_at)`，`UNIQUE(org_id, user_id)`
- `sessions(id = sha256(token), user_id, created_at, expires_at, last_seen_at)`
- `api_keys` 重建：`id INTEGER PK AUTOINCREMENT`、`key_hash UNIQUE`、`name`、`created_by`、`created_at`、`last_used_at`、`last_used_from_addr`、`revoked_at`、`kind(user|org)`、`org_id`、`project_id`。
- `projects` 增加 `org_id`。

`api_keys` 用重建而非 `ALTER`：旧表没有整数 id 和 scope 列，且本地 key 会在引导时重发，没有需要保留的数据。

## 4. 代码结构

| 文件 | 职责 |
|---|---|
| `src/domain/identity.ts` | `Principal`、`canManageOrgKeys` |
| `src/domain/session.ts` | 会话签发/校验（只存 sha256）、scrypt 口令 |
| `src/domain/bootstrap.ts` | 首启播种 owner/org/member/第一把 key，幂等 |
| `src/domain/identity-views.ts` | key/身份/组织/成员的响应视图 |
| `src/http/auth.ts` | key 生成/哈希、凭证解析、`apiAuth` 中间件 |
| `src/http/guard.ts` | `projectGuard`/`orgGuard`、`resolveActingOrg`、admin 校验 |
| `src/http/console-auth.ts` | 登录 / dev 登录 / OIDC / 登出 / 会话查询 |
| `src/http/routes/{api-keys,identity,organizations}.ts` | M5 路由 |

## 5. 鉴权与 scope 语义

- `apiAuth` 先解析 `Authorization: Bearer`（优先）或 cookie `zenith`，解析成功写 `last_used_from_addr` 并把 `Principal` 放到 context。无凭证一律 401。
- `Principal` 三种：`user_key`（个人 key）、`org_key`（可带 `project_id`）、`session`。
- `projectGuard` 拦截 `/projects/:project_id`：project-scoped key 访问非绑定项目 → `PROJECT_NOT_FOUND`；组织 key 越组织 → 同样 404；个人/session 校验项目所属组织在成员列表内。列表接口按同样规则过滤。
- `orgGuard` 拦截 `/organizations/:org_id`：组织 key 只能命中自己的组织；个人/session 必须是成员。
- `resolveActingOrg` 决定创建项目/组织 key 时使用的组织，并校验 `?org_id=`（SiteOps 消费者本就会带）。
- 建组织/项目 key 需 `admin`；不会移除最后一个 admin。

## 6. 控制台

- `GET /console/config`（公开）返回启用哪些登录方式；`/console/{login,dev-login,oidc/start,oidc/callback,logout,session}` 在 `/api/v2` 之外。
- 会话 cookie 名 `zenith`，`httpOnly`、`SameSite=Lax`、`path=/`。
- 三种登录都最终签发同一种会话 cookie；OIDC 用 discovery + 授权码 + PKCE，取 userinfo 后按 email upsert 用户为组织成员。
- 页面新增登录门、API keys 面板（个人 + 组织，创建时显示一次明文、可撤销）、组织成员面板。所有动作仍打 `/api/v2`。

## 7. 配置（新增 env）

`CP_ORG_ID`、`CP_ORG_NAME`、`CP_OWNER_ID`、`CP_OWNER_EMAIL`、`CP_OWNER_NAME`、`CP_OWNER_LAST_NAME`、`CP_OWNER_PASSWORD`、`CP_BOOTSTRAP_API_KEY`、`CP_KEY_PREFIX`（默认 `napi_`）、`CP_SESSION_TTL_SECONDS`、`CP_DEV_LOGIN`、`CP_OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI,SCOPES}`。

## 8. 验收

- `pnpm verify`：typecheck + lint + unit + contract 全绿；新增契约用例全部过官方 schema。
- 单元：`session`（会话/口令）、`bootstrap`（幂等/改密）、`guard`（scope 解析）、`auth`（前缀/地址/org key/会话）、`migration`（0001→0002）。
- 契约：`identity-keys`（key 生命周期、org/项目 scope）、`organizations-members`（org key 列表/撤销、成员改删、最后 admin、越权矩阵、`org_id`、嵌套路径、边界）、`console-auth`（密码/dev/会话 cookie）。
- e2e：`preflight` 增加鉴权探测，缺 key/401 一律 `context.skip(...)` 而不是失败；`siteops-provider` 去掉失效占位 key。
- **数据面最终效果**：新增 `tests/e2e/data-plane.test.ts`——建项目后断言 pageserver 里真有 tenant + timeline、compute 里真有库与角色，DDL（create table/index/alter）与 DML（insert/update/delete/select、事务回滚）真实执行并读回，连接串凭据真能登录。控制台路径同理由浏览器用例验证：用 UI 取到的连接串在宿主机 psql 上跑 DDL/DML（浏览器套件控制面以 `direct` 档运行，端口发布到宿主机）。
- 浏览器（Playwright，`pnpm test:browser`）：真实控制面 + 假 OIDC 提供方，覆盖登录门、密码/dev/OIDC 三种登录、会话持久与登出、粘贴 key、个人 key 建/列/撤销（明文只显示一次）、组织成员、项目生命周期（建/启停/连接串/删）+ **控制台所建项目的 DDL/DML** 与 axe 可访问性烟测。默认用系统 Chrome，项目用例在无 compose 时跳过。
- 覆盖率：`pnpm test:coverage`（unit + contract）。

## 9. 影响与边界

- 严格的整数 id + `napi_` 前缀会作废既有 `neon_cp_` key，本地需按 README 重新引导。
- 消费者 `provider-neon` 带 `org_id` 的调用现在会被校验，`CP_ORG_ID` 应与它的 `NEON_ORGANIZATION_ID` 一致。
- 未做：组织邀请（无邮件通道）、`/projects/{id}/members` 与 `permissions`、完整 RBAC 矩阵；OIDC 仅做通用授权码流程，不含 Keycloak 专属行为。
