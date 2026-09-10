# M0 实测记录：compute

> 日期 2026-09-07 · 任务 [T-004](../design/003_任务分解与验收清单.md) · 镜像 `docker.io/neondatabase/compute-node-v17:latest`（arm64/linux，434 MB，build_tag 8464，PostgreSQL 17.5）  
> 复现：`pnpm compose:up && npx tsx scripts/probe-compute.mjs --variant both|top|guc`

## 一、compute API 需要 JWT —— 本轮最大的发现

`compute_ctl` 的外部 HTTP 端口（3080）**要求签名 JWT**，没有就是 `400 {"error":"invalid authorization token"}`。这就是官方 docker-compose 在 `compute_wrapper/` 里放 `private-key.pem` / `public-key.pem` 的原因，而那份文档从未解释。内部端口 3081 是另一套路由（`/status` 在那里是 404），不能当后门。

合同（逐条从报错里逼出来的）：

| 环节 | 要求 | 报错原文（不满足时） |
|---|---|---|
| spec | `compute_ctl_config.jwks` 必填，否则连配置文件都解析不了 | `Error: missing field 'jwks' at line 127 column 26` |
| 密钥 | Ed25519（`kty: OKP`、`crv: Ed25519`、`alg: EdDSA`），JWK 的 `x` 用标准 base64url | — |
| JWT `aud` | **必须是数组**，不能是字符串 | `failed to decode authorization token using <kid>: JSON error: invalid type: string "compute", expected a sequence` |
| JWT `compute_id` | 必填，且要等于容器启动时的 `--compute-id` | `missing compute_id in authorization token claims` |
| header | `kid` 要能在 jwks 里找到 | `failed to decode authorization token using <kid>` |

落地在 `src/domain/compute-auth.ts`：控制面持有一把 Ed25519 私钥，公钥 JWK 写进每份 spec 的 `compute_ctl_config.jwks`，每次调用现签一个 5 分钟的 token。

## 二、spec 的两种写法都能用（002 §14 第 2 条）

| 写法 | 结果 |
|---|---|
| 只写顶层 `tenant_id` / `timeline_id` / `pageserver_connstring` / `safekeeper_connstrings` | **可用**，compute 起来、`select 1` 通 |
| 只写 `cluster.settings` 里的 `neon.tenant_id` / `neon.timeline_id` / `neon.pageserver_connstring` / `neon.safekeepers` GUC（官方 compose 的写法） | **可用** |
| 两者都写 | **可用** |

**决定**：两者都写。顶层字段是真实控制面的写法、语义清楚；GUC 与官方 compose 一致、是被 CI 持续验证的那条路。两条对齐时不会互相冲突（实测）。

## 三、角色与库的增删（002 §14 第 3、6 条）

spec 里的 `cluster.roles` / `cluster.databases` 在启动时被创建：实测容器里出现 `app_owner`、`cloud_admin`、`neon_superuser`、`to_be_dropped` 四个角色和 `appdb`、`postgres` 两个库，`app_owner` 能用 SCRAM 口令登录 `appdb`。

**删除必须走 `delta_operations`**：

| 动作 | 结果 |
|---|---|
| 把 role 从 spec 的 `cluster.roles` 里去掉后 `POST /configure` | 200，但角色**仍在**（`to_be_dropped` 还在） |
| spec 带 `delta_operations: [{ action: 'delete_role', name: 'to_be_dropped' }]` 后 `POST /configure` | 200，角色**被删除** |

所以 002 §5.3 里"删除依赖 delta_operations"从推测变成必须。库的删除同理用 `delete_db`。

## 四、其他

- `POST /configure` 在 compute 处于 `running` 时可用，返回体就是 `/status` 的结构（002 §14 第 6 条：不需要额外时序处理）。
- `GET /dbs_and_roles` 可用，返回 catalog 里的角色与库，适合做对账与 e2e 断言。
- `--dev` 必须传，否则 compute_ctl 会做 VM 相关操作。官方 compose 的 `compute.sh` 里 `--config` 那行少了续行符，`--dev` 其实没生效——照抄时要注意。
- `privileged-role-name` 默认 `neon_superuser`，该角色由 compute 自动创建。
- 冷启动（拉起容器到 `status=running`）在 Apple Silicon 上约 10 秒（002 §14 第 8 条）。
- 启动日志里的 `Storage auth token not set` 与 OTLP 导出失败（`localhost:4318` 拒绝连接）都是无害噪声。
