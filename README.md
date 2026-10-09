# neon-control-plane

自研的 Neon 控制面：实现 Neon 云端管理 API `console.neon.tech/api/v2` 的一个子集，后端接 Neon 开源自部署组件（`pageserver` / `safekeeper` / `storage_broker` / `compute-node`，入口面可选官方 `proxy`）。

> **非 Neon 官方项目。** Neon 源码为 Apache-2.0，"Neon" 是其商标。本项目只用于本地开发环境，不面向生产自托管。

本项目是独立的 Git 克隆（Apache-2.0），与 Site Growth 单仓平级存放；以下 `pnpm` 和 Compose 命令均从仓库根目录执行，保留本仓库独立锁文件。SiteOps 侧的接线（Caddy、provider、workerd 探针）属于 [Site Growth 单仓](https://github.com/summersmile1984/siteops-monorepo)，不在本仓库范围内。不要把 `compose:down` 当作安全停机命令——它会删除卷。

---

## 目录

- [为什么存在](#为什么存在)
- [它是什么 / 不是什么](#它是什么--不是什么)
- [里程碑与状态](#里程碑与状态)
- [架构总览](#架构总览)
- [内部数据模型](#内部数据模型)
- [快速开始](#快速开始)
- [鉴权与 API key](#鉴权与-api-key)
- [已实现的 API](#已实现的-api)
- [连接路由三档](#连接路由三档)
- [本地运维 console](#本地运维-console)
- [配置项（环境变量）](#配置项环境变量)
- [测试](#测试)
- [目录结构](#目录结构)
- [脚本](#脚本)
- [设计文档与 spec](#设计文档与-spec)
- [常见问题与排错](#常见问题与排错)
- [安全注意事项](#安全注意事项)
- [许可证与商标](#许可证与商标)

---

## 为什么存在

Neon 云端控制面 `console.neon.tech/api/v2` **没有开源实现**（2026-09-07 核实：NeonD 只有 Web 面板、neon-operator 只有 Kubernetes CRD、Neon Local 需要云端 API key）。而 [SiteOps](https://github.com/summersmile1984/siteops-monorepo) 的 `provider-neon` / `neon-provider-service` 依赖这套 API 完成本地联调。

于是本项目自建一个兼容 `api/v2` 的控制面，后端接 Neon 的开源数据面组件，让**未修改的 SiteOps 客户端**、`neonctl` 等消费者能在本地跑通整条链路。

## 它是什么 / 不是什么

**是：**

- 一个 Hono 单进程，监听 `/api/v2`，用 SQLite 保存控制状态。
- 一套**管理器**：建项目/分支/端点，起停 compute 容器，发角色/库/连接串。
- 对外合同 = 官方 OpenAPI `spec/neon-api-v2.json`（原样 vendored，所有响应过其 schema 校验）。
- 本地开发环境的 Neon 替身，入口面可以换成官方 proxy。

**不是：**

- 不是生产可用的多租户控制面（无计费、无配额、无多 safekeeper、无 K8s）。
- 不实现 M4（多 safekeeper / storage_controller / k8s）。
- 不替代生产 Neon Cloud；本地数据面只是开发用。

## 里程碑与状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | pageserver / compute 真机探测，确立概念映射 | 完成 |
| **M1** | projects / branches / endpoints / databases / roles / connection_uri | 完成 |
| **M2** | 按时间点建分支（PITR） | 完成 |
| **M3** | start / suspend / restart + 官方 proxy（`/cplane/*`） | 完成 |
| **M4** | 多 safekeeper / storage_controller / K8s | **不做**（不解决本地开发问题） |
| **M5** | API key 管理、鉴权、身份面、控制台登录 | 完成 |

M0–M3 用真东西证过（非 mock）：未经修改的 SiteOps `provider-neon` 客户端跑通全链路；官方 Neon proxy 在前做 TLS + SNI + SCRAM + 按需唤醒；Directus 用本控制面发的连接串跑完所有引导迁移。

`pg_sni_router` 实测后放弃：它在 Neon 连接串的单标签主机名上直接 panic，且不做鉴权、不能唤醒挂起的 compute（见 [003](docs/design/003_任务分解与验收清单.md) T-201）。proxy 覆盖其全部用途。

## 架构总览

```
                     ┌──────────────────────────────────────────┐
   neonctl /         │            neon-control-plane             │
   provider-neon ───►│  Hono  /api/v2  +  /console  +  /cplane   │
   (Bearer key)      │  SQLite 控制状态 + operations/reconciler  │
                     └───────┬───────────────┬──────────────┬────┘
                             │ HTTP          │ Docker API   │ HTTP / JWT
                             ▼               ▼              ▼
                        pageserver      compute 容器    compute_ctl
                        safekeeper      (compute-node)  (spec / 唤醒)
                        storage_broker
```

- 一个 Hono 进程 + SQLite（WAL）+ 三个 adapter：pageserver HTTP、Docker Engine、compute_ctl HTTP。
- **写操作先落 `operations` 行**，再由 reconciler 逐步执行；每步幂等、失败退避重试五次、重启从 `cursor_step` 续跑。
- `project` ↔ 一个 pageserver **tenant**；`branch` ↔ 一条 **timeline**；`endpoint` ↔ 一个 compute-node **容器**。
- 连接路由分离：数据面（Postgres）和入口面（proxy/直接端口）由 `CP_ROUTE_MODE` 决定。

### 概念映射

| Neon API 概念 | 本地实现 |
|---|---|
| Project | pageserver tenant + 默认 branch + 默认 endpoint |
| Branch | pageserver timeline（可带 `parent_timestamp` 做 PITR） |
| Endpoint (read_write/read_only) | compute-node 容器（Primary / Replica 模式） |
| Role | compute 上的 Postgres 角色 + SCRAM verifier（可 `reveal_password`） |
| Database | compute 上的 Postgres 库，属于某个 branch |
| Operation | `operations` 表行 + reconciler 状态机 |
| Connection URI | 由路由档生成的 `postgresql://...` |
| API key | `api_keys` 表，sha256 存储，个人 / 组织 / 项目 scoped |

## 内部数据模型

迁移在 `src/store/migrations/`，由 `src/store/db.ts` 启动时按文件名顺序应用：

- `0001_init.sql`：`projects`、`branches`、`endpoints`、`roles`、`databases`、`operations`、`api_keys`、`settings`。
- `0002_identity_keys.sql`：`users`、`organizations`、`members`、`sessions`；重建 `api_keys`（整数 id、scope、撤销等）；`projects.org_id`。

**Operation 状态机：** `scheduling → running → finished | failed`（失败退避重试，5 次后 `failed`）。操作动作包括 `create_timeline`、`delete_timeline`、`create_branch`、`start_compute`、`suspend_compute`、`apply_config`、`create_compute`、`tenant_detach`、`check_availability`。

**错误码**（`src/http/errors.ts`，`ErrorCode` 在官方 spec 里是自由字符串，故这是本地词表）：`AUTH_FAILED`、`BAD_REQUEST`、`RESOURCE_NOT_FOUND`、`PROJECT_NOT_FOUND`、`BRANCH_NOT_FOUND`、`ENDPOINT_NOT_FOUND`、`ROLE_NOT_FOUND`、`DATABASE_NOT_FOUND`、`ALREADY_EXISTS`、`WRONG_LSN_OR_TIMESTAMP`、`PRECONDITION_FAILED`、`RUNNING_OPERATIONS`、`NOT_IMPLEMENTED`、`FORBIDDEN`、`ORG_NOT_FOUND`、`MEMBER_NOT_FOUND`。

## 快速开始

### 前置

- Node.js ≥ 22 且 < 25
- pnpm
- Docker（跑 pageserver / safekeeper / compute 容器）
- 可选：`psql`（e2e / 数据面用例用）

### 步骤

```sh
pnpm i
cp .env.example .env
# 生成并填入 CP_MASTER_KEY（32 字节 base64）
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

cp infra/compose/.env.example infra/compose/.env
pnpm compose:up     # pageserver + safekeeper + storage_broker + 对象存储（约 9 GB 镜像）
pnpm dev            # 控制面监听 :8080
```

对象存储用 **rustfs**（MinIO 的镜像已全部下架：Docker Hub 上每个 tag 都 404，quay.io 匿名拉取返回 401，只有还缓存着旧镜像的机器能跑）。服务名仍叫 `minio`，宿主机 API/控制台端口默认 `19000`/`19001`，可用 `NEON_MINIO_API_PORT`/`NEON_MINIO_CONSOLE_PORT` 覆盖，容器网络仍是 `minio:9000`，因此可与 `siteops-platform` 本地栈的宿主机 `9000`/`9001` 并行运行；换别的 S3 实现用 `NEON_S3_IMAGE`。`compose:down` 会删除卷，不能用于无损停机或冒烟测试。

首启会从 env 播种一个 owner、一个组织。设 `CP_BOOTSTRAP_API_KEY` 可以在启动时直接得到第一把 key：

```sh
CP_BOOTSTRAP_API_KEY=napi_local_dev_key CP_OWNER_PASSWORD=local-dev-password pnpm dev
```

建项目：

```sh
curl -X POST localhost:8080/api/v2/projects \
  -H 'authorization: Bearer napi_local_dev_key' \
  -H 'content-type: application/json' \
  -d '{"project":{"name":"demo","pg_version":17}}'
```

返回体里就有 `connection_uris[0].connection_uri`；等 `start_compute` 操作 `finished`（约 10 秒）后即可连接。

若没设 `CP_BOOTSTRAP_API_KEY`，可在控制面起后用脚本补一把（控制面会读同一个 SQLite）：

```sh
pnpm create-api-key "local dev"
```

## 鉴权与 API key

控制面**始终要求鉴权**——没有"无 key 时放行"的窗口。两种凭证：

### 1. Bearer API key

```
Authorization: Bearer napi_...
```

- **个人 key**（`kind=user`）：默认访问所属组织的项目；带 `?org_id=` 时校验成员关系。任意成员都能建/撤销自己的个人 key。
- **组织 key**（`kind=org`）：固定到某个组织，org 内 admin 级。只有组织 `admin` 能创建。
- **项目 scoped key**：组织 key 变体，带 `project_id`，**只能访问绑定的那一个项目**；访问其它项目返回 `404`（避免枚举）。

token 前缀默认 `napi_`（`CP_KEY_PREFIX` 可改），只在**创建时回显一次**，库里只存 sha256。撤销后立即失效。

### 2. 控制台会话 cookie

浏览器登录后签发名为 `zenith` 的会话 cookie（`httpOnly`、`SameSite=Lax`）。`/api/v2` 与 `/console/state` 都接受它，等价于该用户的个人权限。

### 引导（bootstrap）

首启幂等地播种：

| env | 作用 |
|---|---|
| `CP_ORG_ID` / `CP_ORG_NAME` | 组织 id/名称。默认 `org-super-glade-55833945`，与 SiteOps 的 `NEON_ORGANIZATION_ID` 对齐 |
| `CP_OWNER_ID` / `CP_OWNER_EMAIL` / `CP_OWNER_NAME` / `CP_OWNER_LAST_NAME` | owner 用户。邮箱必须是合法格式（含域名） |
| `CP_OWNER_PASSWORD` | 可选的本地密码登录口令；不设则密码登录关闭 |
| `CP_BOOTSTRAP_API_KEY` | 可选的 owner 首把个人 key（明文，仅在启动时使用） |

### key 管理 API

| 路径 | 方法 |
|---|---|
| `/api_keys` | GET / POST |
| `/api_keys/{key_id}` | DELETE |
| `/organizations/{org_id}/api_keys` | GET / POST（body 可带 `project_id`） |
| `/organizations/{org_id}/api_keys/{key_id}` | DELETE |

## 已实现的 API

`spec/SUBSET.md` 列出 **30 条**路径（官方 122 条的子集），全部可用：

**资源面**

- `projects`（GET/POST、GET/PATCH/DELETE、`/operations`）
- `branches`（GET/POST、GET/PATCH/DELETE、`set_as_default`、`parent_timestamp` PITR）
- `endpoints`（GET/POST、GET/PATCH/DELETE、`start` / `suspend` / `restart`）
- `branches/{id}/databases`（GET/POST、GET/PATCH/DELETE）
- `branches/{id}/roles`（GET/POST、GET/DELETE、`reset_password`、`reveal_password`）
- `connection_uri`

**身份 / key 面（M5）**

- `api_keys`、`organizations/{org_id}/api_keys`
- `/auth`、`/users/me`、`/users/me/organizations`
- `organizations/{org_id}`、`organizations/{org_id}/members`（含成员改角色/移除）

**运维面**

- `/healthz`、`/readyz`（公开）
- `/console`、`/console/state`（控制台，非 Neon 合同）
- `/cplane/get_endpoint_access_control`、`/cplane/wake_compute`（官方 proxy 私有接口）

> 对外合同以 `spec/neon-api-v2.json` 为准，非生产环境下所有响应都过它的 schema 校验。

## 连接路由三档

由 `CP_ROUTE_MODE` 控制，决定 `connection_uri` 的形状和入口：

| 档 | URI 形状 | 用途 |
|---|---|---|
| `direct` | `postgresql://role:pw@127.0.0.1:<hostPort>/db?sslmode=disable` | compute 端口发布到宿主机，本机 psql 直连；e2e / 浏览器套件用 |
| `proxy` | `postgresql://role:pw@<ep>.<zone>/db?sslmode=require&channel_binding=require` | 本地开发主用；前面是官方 Neon proxy（TLS + SNI + SCRAM + 按需唤醒） |
| `sni-router` | `postgresql://role:pw@<ep>--compute--55433.<zone>:5432/db?...` | 仅供 K8s；本地不提供路由器 |

后两档 URI 省略端口并带 `sslmode=require&channel_binding=require`，这是 SiteOps 客户端解析所要求的形状。

**容器内的客户端**（如 Directus）看到的 proxy 是 `host.docker.internal`，端点 id 无法塞进该主机名，用 Neon 的启动包回退参数即可（不依赖 DNS）：

```
postgresql://<role>:<pw>@host.docker.internal:5434/<db>?sslmode=no-verify&options=endpoint%3D<endpoint_id>
```

## SiteOps workerd 的 SQL HTTP / WebSocket 入口

proxy 的 `--http` 是监控/健康端口；SQL `/sql` 和 WebSocket `/v2` 由 `--wss` 提供。compose 已明确拆开：7001 发布 SQL HTTPS/WSS，7002 仅在容器内提供监控。不要把 7001 返回一个健康页当作 SQL 可用。

生成独立的开发 CA 和服务证书（不会安装系统信任，也不会覆盖已有目录）：

```sh
node scripts/create-local-tls.mjs --output data/neon-tls --zone db.siteops.localhost
```

在 compose 环境中设置 `PROXY_CERT_DIR` 为该目录的绝对路径。proxy 读取 `wildcard.crt` / `wildcard.key`；Node/Miniflare 启动前将 `NODE_EXTRA_CA_CERTS` 指向 **ca.crt**。SiteOps T03 实测，自签名且 CA:FALSE 的叶证书虽然能在 Node 查询，但 workerd 请求失败；换成 CA 签发链后 HTTP/WSS 均通过。不要关闭 TLS 校验或将 leaf 当 CA 使用。证书有效期 30 天，更新时生成新目录并有序切换；不要把私钥提交到仓库。

管理 API 创建的角色具有 Neon 管理权限；应用/站点角色须经 owner SQL 创建 `LOGIN NOINHERIT` 的受限角色。proxy 现在通过带签名的 compute_ctl `/dbs_and_roles` 读取实际 SCRAM verifier，因此支持这些 SQL 角色的连接及密码变更；不会将它们写回 managed roles/spec 并在重启时提升权限。私有 `/cplane/*` 必须配置 `CP_PROXY_TOKEN`，缺失配置直接拒绝。数据库的 NOLOGIN/权限约束仍由 Postgres 最终执行。

不同管理实例必须使用不同的 `CP_INSTANCE_ID`、SQLite 路径、compute 目录和端口区间。启动回收只触及本实例标签下、当前账本不存在的 compute；未设置 instance id 时不执行孤儿回收。旧的无实例标签容器不会自动迁入或删除。更换 DB 文件时不能复用旧实例 ID，否则旧资源会被视为该实例的孤儿。

可重复验证入口在相邻 SiteOps 平台仓库的 `pnpm preflight:local-neon`，包含管理 API 建临时项目、SQL 站点角色、实际 workerd HTTP/WSS 访问及项目删除读回；其报告不代表完整产品建站通过。

## 本地运维 console

控制面起来后打开 <http://localhost:8080/console>（`/` 是同一个页面）。

它回答 API 回答不了的问题：现在什么在跑、哪一步失败了、连接串是什么。包含：

- 栈健康度（pageserver / docker 可达性）、项目/端点/角色/库总览；
- 跨项目操作流（含失败原因）；
- **状态漂移**告警：SQLite 里的 endpoint 状态与 Docker 里的容器实际情况对不上时标红——这是本地栈出问题时最有用、而 v2 API 给不出来的信号（它需要同时看两份状态）；
- **登录门**：邮箱+密码 / 一键 dev 登录 / 通用 OIDC（三种）；
- **API keys 面板**：个人与组织 key 的列表 / 创建（明文只显示一次）/ 撤销；
- **组织成员面板**。

页面上的每个数据动作（建项目、start/suspend/restart、删项目、取连接串、建/撤 key）都打真正的 `/api/v2` 路由，所以 console 与 `provider-neon`、`neonctl` 走完全相同的合同。它挂在 `/api/v2` 之外，不属于 Neon 合同，**不要让任何客户端依赖它**。

快照里**没有口令**：只回"是否存了口令"，口令仍只能经 `reveal_password` 对单个角色显式索取。页面是单文件、无构建、无 CDN，断网可用。

## 配置项（环境变量）

### 控制面

| 变量 | 默认 | 说明 |
|---|---|---|
| `CP_PORT` | `8080` | 监听端口 |
| `CP_DB_PATH` | `./data/cp.sqlite` | SQLite 路径 |
| `CP_INSTANCE_ID` | 未设置 | compute 所有权标签；未设置不回收孤儿；与 SQLite 生命周期一致 |
| `CP_MASTER_KEY` | —（必填） | 32 字节 base64；用于加密存库口令 |
| `CP_VALIDATE_RESPONSES` | `1` | 响应过官方 OpenAPI schema 校验 |

### 存储层

| 变量 | 默认 | 说明 |
|---|---|---|
| `CP_PAGESERVER_URL` | `http://127.0.0.1:9898` | pageserver HTTP |
| `CP_PAGESERVER_CONNSTRING` | `"host=pageserver port=6400"` | 传给 compute 的 libpq 串（**含空格必须加引号**） |
| `CP_SAFEKEEPERS` | `safekeeper1:5454` | 逗号分隔 |
| `CP_NEON_TAG` | `latest` | 存储与 compute 必须同一 CI build |
| `CP_COMPUTE_IMAGE_REPO` | `docker.io/neondatabase` | compute 镜像仓库 |

### compute 容器

| 变量 | 默认 | 说明 |
|---|---|---|
| `CP_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket |
| `CP_DOCKER_NETWORK` | `neon-cp` | 容器网络 |
| `CP_COMPUTE_VOLUME_ROOT` | `./data/computes` | compute 卷根目录 |
| `CP_PORT_RANGE` | `55500-55700` | 发布端口范围 |

### 连接路由

| 变量 | 默认 | 说明 |
|---|---|---|
| `CP_ROUTE_MODE` | `direct` | `direct` / `sni-router` / `proxy` |
| `CP_ZONE` | `db.siteops.localhost` | 端点主机后缀 |
| `CP_PROXY_TOKEN` | 空 | 官方 proxy 访问 `/cplane/*` 时携带的 bearer |

### 身份与 API key（M5）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CP_ORG_ID` | `org-super-glade-55833945` | 引导组织 id |
| `CP_ORG_NAME` | `Local Organization` | 组织名 |
| `CP_OWNER_ID` | uuid | owner 用户 id |
| `CP_OWNER_EMAIL` | `owner@neon.localhost` | 必须合法邮箱 |
| `CP_OWNER_NAME` / `CP_OWNER_LAST_NAME` | `Local Owner` / 空 | |
| `CP_OWNER_PASSWORD` | 空 | 启用控制台密码登录 |
| `CP_BOOTSTRAP_API_KEY` | 空 | 首把个人 key |
| `CP_KEY_PREFIX` | `napi_` | key 前缀 |
| `CP_SESSION_TTL_SECONDS` | `2592000` | 会话有效期（30 天） |
| `CP_DEV_LOGIN` | `0` | 一键 dev 登录（**仅本地**） |
| `CP_OIDC_ISSUER` | 空 | 设置即启用通用 OIDC 登录 |
| `CP_OIDC_CLIENT_ID` / `CP_OIDC_CLIENT_SECRET` | 空 | |
| `CP_OIDC_REDIRECT_URI` | `http://localhost:8080/console/oidc/callback` | |
| `CP_OIDC_SCOPES` | `openid email profile` | |

### compose（`infra/compose/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEON_REPOSITORY` / `NEON_TAG` | `docker.io/neondatabase` / `latest` | 镜像 |
| `PG_VERSION` | `17` | |
| `CP_PROXY_TOKEN` | `local-proxy-token` | 与 `CP_PROXY_TOKEN` 一致 |
| `CP_PORT` | `8080` | proxy 回连控制面的端口 |
| `PROXY_PORT` / `PROXY_HTTP_PORT` | `5432` / `7001` | Postgres wire / SQL HTTPS 与 WSS |
| `PROXY_CERT_DIR` | `./certs` | 服务证书目录；推荐绝对路径，使用 CA 签发的 wildcard.crt/key |
| `NEON_MINIO_API_PORT` / `NEON_MINIO_CONSOLE_PORT` | `19000` / `19001` | 仅宿主机映射；容器内保留 9000 / 9001 |

## 测试

四层，按需要真实组件程度划分：

| 层 | 命令 | 依赖 | 规模 |
|---|---|---|---|
| 单元 | `pnpm test:unit` | 无 | 82（session / bootstrap / guard / migration / auth / repo / scram / ids / secrets / connection-uri / spec-builder） |
| 契约 | `pnpm test:contract` | 无（内存 SQLite + 假 adapter） | 116（含 key 生命周期、成员/越权矩阵、console 登录，全部过官方 schema） |
| 端到端 | `pnpm test:e2e` | 真 pageserver / safekeeper / compute、proxy、psql | 38（缺前置条件自动 skip） |
| 浏览器 | `pnpm test:browser` | Playwright（系统 Chrome）+ 真控制面；项目用例需 compose | 11 |

`pnpm verify` = `typecheck + lint + test:unit + test:contract`。`pnpm test:coverage` 生成文本报告与 `coverage/index.html`（unit + contract）。

### 端到端（e2e）

```sh
pnpm compose:up
PROXY_PORT=5434 docker compose -f infra/compose/docker-compose.yml --profile proxy up -d proxy
CP_ROUTE_MODE=proxy CP_BOOTSTRAP_API_KEY=napi_local_e2e_key CP_OWNER_PASSWORD=local-dev-password pnpm dev
CP_API_KEY=napi_local_e2e_key CP_ROUTE_MODE=proxy CP_PROXY_PORT=5434 pnpm test:e2e
```

| 文件 | 证到什么 |
|---|---|
| `pageserver-smoke` | adapter 对真 pageserver 的方法（tenant/timeline/LSN） |
| `full-lifecycle` | compute 真提供 PostgreSQL 17；建删角色/库走 `delta_operations`；挂起重启；PITR 子分支只看截点前数据 |
| `data-plane` | **数据面最终效果**：项目在 pageserver 里真有 tenant + timeline；库/角色存在；DDL（create table/index/alter）与 DML（insert/update/delete/select、事务回滚）真实执行并读回；连接串凭据真能登录 |
| `proxy-connect` | psql 经官方 proxy 连上（SNI 与启动包两种寻址）；错口令被拒；挂起后冷启动唤醒并保留数据 |
| `tenant-isolation` | 两租户各自 tenant/timeline/compute/role/db；拿 A 凭据连 B endpoint 被拒；删 A 后 B 完好 |
| `siteops-provider` | 真实 SiteOps `provider-neon` 客户端经 HTTPS 跑完 provider 调用 |
| `directus-on-control-plane` | Directus 迁移落在控制面起的 compute；挂起后下一请求恢复 |

前置条件缺失时用例**报跳过而不是失败**（`context.skip(reason)`）：没起控制面、`CP_API_KEY` 未设或 401、没起 proxy、`psql` 不在 PATH、没有 SiteOps Caddy、没有 `siteops-directus-container` 镜像。

`siteops-provider` 还需要一份 SiteOps 检出。默认在同级目录找 `site-growth/siteops-platform`；放在别处时用 `SITEOPS_PLATFORM_DIR` 指定它的绝对路径。

### 浏览器（console E2E）

Playwright 自己拉起一个**独立端口**的控制面（`data/browser-e2e.sqlite`、端口段 55800-55820、`direct` 档）和一个内建**假 OIDC 提供方**，不会与你正在跑的 `pnpm dev` 冲突：

```sh
pnpm test:browser
CP_BROWSER_PORT=8090 pnpm test:browser   # 自定义端口
```

覆盖：登录门、密码 / dev / OIDC 三种登录、会话持久与登出、粘贴 API key、个人 key 建/列/撤销、组织成员、项目生命周期（建/启停/取连接串/删），以及**用控制台发出的连接串在宿主机跑 DDL/DML** 并断言 pageserver 里真有该项目。另有 axe 可访问性烟测（无 serious/critical）。默认系统 Chrome，`PW_CHANNEL=chromium` 可切打包浏览器；失败留 trace/截图于 `test-results/`。

## 目录结构

```
src/
  index.ts                 进程入口：config → db → adapters → service → app → reconciler
  config.ts                环境变量加载与校验（fail fast）
  service.ts               业务层：项目/分支/端点/角色/库的编排
  logger.ts                结构化日志
  adapters/
    pageserver.ts          pageserver HTTP（tenant/timeline/LSN）
    docker.ts              Docker Engine（compute 容器生命周期）
    compute.ts             compute_ctl HTTP（spec 下发 / 状态）
  domain/
    compute-auth.ts        compute JWT 签名与 JWKS
    connection-uri.ts      三档路由的连接串生成
    ids.ts                 项目/分支/端点/操作 id 生成
    scram.ts               SCRAM-SHA-256 verifier
    secrets.ts             口令加密（CP_MASTER_KEY）
    spec-builder.ts        compute spec 组装（settings/delta_operations）
    views.ts               Row → v2 响应对象
    identity.ts            Principal / 角色判定
    session.ts             会话签发与口令哈希（scrypt）
    identity-views.ts      key/身份/组织/成员视图
    bootstrap.ts           首启播种 owner/org/key（幂等）
  http/
    app.ts                 路由挂载、错误处理、request id
    env.ts                 共享 Hono 环境类型
    auth.ts                key 生成/哈希、凭证解析、apiAuth 中间件
    guard.ts               scope 执行（project/org 守卫）
    respond.ts             统一响应出口 + schema 校验
    validate.ts            vendored OpenAPI 的 Ajv 校验器
    errors.ts              错误词表与 ApiError
    console-auth.ts        控制台登录 / dev / OIDC / 登出 / 会话
    routes/
      projects.ts branches.ts endpoints.ts   资源面
      api-keys.ts identity.ts organizations.ts  key/身份面（M5）
      cplane.ts            官方 proxy 私有接口
      console.ts           /console 页面与快照
      helpers.ts           请求解析与查找
  store/
    db.ts                  SQLite 打开 + 迁移
    repo.ts                仓储层（含 users/orgs/members/sessions/apiKeys）
    rows.ts                行类型
    migrations/            0001_init.sql、0002_identity_keys.sql
  console/index.html       单文件运维控制台（无构建、无 CDN）
tests/
  unit/ contract/ e2e/ browser/ support/
infra/compose/             本地栈（pageserver/safekeeper/storage_broker/对象存储/proxy）
spec/                      vendored 官方 OpenAPI + SUBSET.md
docs/design/ docs/notes/   设计文档与真机实测笔记
```

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | `tsx watch` 起控制面（读 `.env`） |
| `pnpm start` | 直接跑（`--experimental-strip-types`） |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / ESLint |
| `pnpm test` | 全部 vitest 项目（含 e2e） |
| `pnpm test:unit` / `test:contract` / `test:e2e` / `test:browser` / `test:coverage` | 分层测试 |
| `pnpm verify` | typecheck + lint + unit + contract |
| `pnpm compose:up` / `compose:down` / `compose:logs` | 本地栈 |
| `pnpm create-api-key "<name>"` | 直接对 SQLite 建 key（`--kind org --org <id>`） |
| `pnpm spec:facts` | 升级 `spec/neon-api-v2.json` 后先跑，核对 spec 事实 |
| `pnpm probe:pageserver` / `probe:compute` | 真机探测脚本 |

## 发布

版本号只有一处来源：`package.json` 的 `version`。

- `ci`：每个 PR 与 `main` 推送跑两个 job。`quality` 是 `pnpm verify`（无 Docker、秒级）；`e2e` 起真栈（pageserver + safekeeper + 一个 compute 容器），先在 `direct` 档跑一遍，再签自签证书、起官方 proxy、切到 `proxy` 档跑第二遍——否则 38 条里会有 20 条被跳过，跳掉的恰好是 proxy SCRAM、连接唤醒、租户隔离这些。
- `release`：推送 `v*` tag 时触发，先校验 tag 与 `package.json` 版本一致，再用 `gh` 建 GitHub Release，notes 按提交自动生成。

```bash
# 改 package.json 的 version → 提交推送 → 等 CI 绿 → 打同名 tag
git tag v0.1.0 && git push origin v0.1.0
```

打错了就删掉重来：`gh release delete v0.1.0 && git push --delete origin v0.1.0`，改完再打。发布只发源码快照，不发 npm 包（本项目 `private: true`）也不发镜像（仓库没有 Dockerfile）。

## 设计文档与 spec

| 文档 | 内容 |
|---|---|
| [001 设计与卡点分析](docs/design/001_Neon_API_v2兼容控制面_设计与卡点分析.md) | 概念映射、架构、三档连接路由、13 项卡点 |
| [002 代码级实施方案](docs/design/002_代码级实施方案.md) | 文件清单、SQL、状态机、函数签名、错误码、测试设计 |
| [003 任务分解与验收清单](docs/design/003_任务分解与验收清单.md) | `T-xxx` 任务与验收命令 |
| [004 API key 与鉴权对齐方案](docs/design/004_API_key与鉴权对齐方案.md) | M5：key 管理、身份面、控制台、schema 对齐 |
| [M0 pageserver 实测](docs/notes/M0-pageserver-findings.md) | 真机事实（重复建 timeline 幂等、删除异步等） |
| [M0 compute 实测](docs/notes/M0-compute-findings.md) | compute API 的 JWT 合同、spec 写法、删角色必须 delta |

`spec/neon-api-v2.json` 是官方 OpenAPI 原样 vendored（`https://neon.com/api_spec/release/v2.json`，2026-10-08 同步，122 条路径），**禁止手改**：它是唯一的对外合同来源。刷新后先跑 `pnpm spec:facts`，再看 `pnpm verify` 是否仍全绿。

## 常见问题与排错

- **`.env` 含空格的值必须加引号**：`CP_PAGESERVER_CONNSTRING="host=pageserver port=6400"`。否则会被 shell 截断，compute 卡在 `init`（配置加载会拒绝这种值）。
- **401 全是意料之中**：控制面始终要求鉴权。确认请求带了 `Authorization: Bearer napi_...`，且 key 未撤销。本地 e2e 需把控制面的 `CP_BOOTSTRAP_API_KEY` 与测试的 `CP_API_KEY` 设成同一个值。
- **组织不匹配 → 404/403**：消费者 `provider-neon` 会在项目请求上带 `?org_id=`。让 `CP_ORG_ID` 与 SiteOps 的 `NEON_ORGANIZATION_ID` 一致（默认已对齐）。
- **proxy 模式连不上**：宿主 5432 常被本机 PostgreSQL 占用，用 `PROXY_PORT=5434` 起 proxy 并设 `CP_PROXY_PORT=5434`。
- **项目/库建了但连不上**：确认对应 `start_compute` 操作已 `finished`；`direct` 档确认宿主机对应端口可用，`proxy` 档确认 proxy 容器与 `CP_PROXY_TOKEN` 一致。
- **`/console/state` 返回 401**：页面是公开外壳，数据要登录或粘贴 key。
- **容器里的客户端连 proxy**：用 `host.docker.internal` + `options=endpoint%3D<id>` 回退寻址（见上）。
- **状态漂移**：console 标红表示 SQLite 里 endpoint 是 `active` 但容器没了（多半被手工 `docker rm` 或 start 半路失败）。
- **`host port NNNNN is published by container …`**：`start_compute` 不会去抢已被别的容器发布的端口（另一个控制面实例、或上次遗留的 compute）。Docker 会静默丢弃冲突的端口映射，于是 `await_ready` 一直在轮询别人的 compute 并收到 401。`docker rm -f` 掉报错里点名的容器，或改 `CP_PORT_RANGE`，操作重试就会自己恢复。

## 安全注意事项

- **token 只显示一次**：创建 API key 时立即保存；库里只存 sha256，无法找回，只能撤销重发。
- **口令加密存储**：Postgres 角色口令用 `CP_MASTER_KEY` 加密后入库；`reveal_password` 才解密返回。
- **不要提交机密**：`.env`、`data/`、`infra/compose/certs/`、`infra/compose/.env`、`*.key` 已在 `.gitignore` 中。测试产物的 `data/browser-e2e.sqlite` 也在 `data/` 下。
- **仅本地**：`CP_DEV_LOGIN=1` 与 OIDC 登录是本地开发便利；不要暴露到公网。
- **`CP_MASTER_KEY` / `CP_BOOTSTRAP_API_KEY` / `CP_PROXY_TOKEN`** 视为机密，轮换后旧值立即失效。

## 许可证与商标

- 本项目以 [Apache-2.0](LICENSE) 授权。
- "Neon" 是 Neon 的商标，Neon 源码为 Apache-2.0；本项目与其无隶属关系。
- 官方 OpenAPI (`spec/neon-api-v2.json`) 原样 vendored，仅用于契约校验。
