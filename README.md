# neon-control-plane

实现 Neon 云端管理 API `console.neon.tech/api/v2` 子集的自研控制面，后端接 Neon 开源自部署组件（pageserver / safekeeper / storage_broker / compute-node）。**非 Neon 官方项目**；Neon 源码 Apache-2.0，"Neon" 是其商标。

存在的理由：开源界没有兼容 `api/v2` 的实现（2026-09-07 核实：NeonD 只有 Web 面板，neon-operator 只有 Kubernetes CRD，Neon Local 需要云端 API key），而 SiteOps 的 `neon-provider-service` 依赖这套 API。

## 状态：M0–M3 全部完成（2026-09-07）

控制面能建项目、建分支（含按时间点）、起停 compute 容器、发角色与库、发能真正登录的连接串。三件事已经用真东西证过，不是 mock：**未经修改的 SiteOps `provider-neon` 客户端**跑通整条链路；**官方 Neon proxy** 在前面做 TLS + SNI + SCRAM + 按需唤醒；**Directus** 用本控制面发的连接串跑完了全部引导迁移。

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm lint` | 0 错 |
| 单元测试 | 59 通过 |
| 契约测试（响应过官方 OpenAPI schema + SiteOps 消费者规则 + proxy 消息形状） | 84 通过 |
| 端到端（真 pageserver + safekeeper + compute 容器） | 32 通过 |

e2e 分六个文件：

| 文件 | 用例 | 证到什么 |
|---|---|---|
| `pageserver-smoke` | 7 | adapter 对真 pageserver 的 9 个方法 |
| `full-lifecycle` | 5 | compute 真的提供 PostgreSQL 17.5；SCRAM 登录；建删角色与库走 `delta_operations`；挂起重启；**按时间点建分支后子分支只看到截点前的数据** |
| `proxy-connect` | 5 | psql 经官方 proxy 连上（SNI 与启动包两种寻址）；错口令被拒；**挂起后冷启动 1.2 秒唤醒**并读到挂起前的数据 |
| `tenant-isolation` | 6 | 两租户各自 tenant/timeline/compute/role/db；**拿 A 的凭据连 B 的 endpoint 被拒**；删掉 A 后 B 完好 |
| `siteops-provider` | 6 | 真实 SiteOps 客户端经 `https://neon-api.siteops.localhost:8443` 跑完 13 个 provider 调用 |
| `directus-on-control-plane` | 3 | Directus 33 张表 / 107 条迁移落在控制面起的 compute；compute 挂起后下一个请求恢复 |

**M4（多 safekeeper / storage_controller / k8s）不做**：这套东西是给本地开发环境用的，M4 不解决本地开发的任何问题。

`pg_sni_router`（T-201）实测后放弃：它在 Neon 连接串的单标签主机名上直接 panic，而且不做鉴权、不能唤醒挂起的 compute。proxy 覆盖它的全部用途，见 [003](docs/design/003_任务分解与验收清单.md) T-201。

## 快速开始

```sh
pnpm i
cp .env.example .env                 # 填 CP_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

cp infra/compose/.env.example infra/compose/.env
pnpm compose:up                      # pageserver + safekeeper + storage_broker + MinIO（约 1.9 GB 镜像）
pnpm dev                             # 控制面监听 :8080

curl -X POST localhost:8080/api/v2/projects \
  -H 'content-type: application/json' \
  -d '{"project":{"name":"demo","pg_version":17}}'
```

返回体里就有 `connection_uris[0].connection_uri`；等 `start_compute` 操作 finished（约 10 秒）后即可连接。

```sh
node scripts/create-api-key.mjs "local"   # 建第一把 key 之后，接口开始强制鉴权
pnpm verify                                # typecheck + lint + unit + contract
pnpm spec:facts                            # 升级 spec/neon-api-v2.json 后先跑它
```

跑全部 e2e 需要 proxy 与控制面都起着。宿主机 5432 常被本机 PostgreSQL 占用，所以 proxy 端口可配：

```sh
pnpm compose:up
PROXY_PORT=5434 docker compose -f infra/compose/docker-compose.yml --profile proxy up -d proxy
CP_ROUTE_MODE=proxy pnpm dev
CP_PROXY_PORT=5434 pnpm test:e2e
```

前置条件缺失时用例**报跳过而不是报失败**：没起控制面、没起 proxy、`psql` 不在 PATH、没有 SiteOps 的 Caddy、本地没有 `siteops-directus-container` 镜像，都会打印原因后跳过。

`.env` 里含空格的值必须加引号（`CP_PAGESERVER_CONNSTRING="host=pageserver port=6400"`），否则 compute 会卡在 `init`——配置加载会拒绝这种值。

## 本地运维 console

控制面起来后打开 <http://localhost:8080/console>（`/` 是同一个页面）。

它回答的是 API 回答不了的那类问题：现在什么在跑、哪一步失败了、连接串是什么。一页里有栈健康度（pageserver / docker 可达性）、全部项目的分支/端点/角色/库、跨项目的操作流（含失败原因），以及**状态漂移**告警——SQLite 里的 endpoint 状态和 Docker 里的容器实际情况对不上时标红，这是本地栈出问题时最有用的一个信号，而它需要同时看两份状态才能判断，所以 v2 API 给不出来。

页面上的每个动作（建项目、start / suspend / restart、删项目、取连接串）都打真正的 `/api/v2` 路由，所以 console 和 `provider-neon`、`neonctl` 走完全相同的合同。它挂在 `/api/v2` 之外，不属于 Neon 合同，别让任何客户端依赖它。

快照里**没有口令**：只回"是否存了口令"，口令仍然只能经 `reveal_password` 对单个角色显式索取。页面是单文件、无构建、无 CDN，断网可用。建了 API key 之后，把 key 填到页面右上角。

## 已实现的 API

`spec/SUBSET.md` 列出的 20 条路径全部可用：projects、branches（含 `set_as_default`、`parent_timestamp`）、endpoints（含 start/suspend/restart）、databases、roles（含 `reset_password`、`reveal_password`）、`connection_uri`、operations。加 `/healthz`、`/readyz`。

连接路由三档：`direct`（把 compute 端口发布到宿主机，本机 psql 直接可连）、`proxy`（本地开发用这档）、`sni-router`（只保留代码，本地栈不提供路由器，见上）。后两档的 URI 省略端口并带 `sslmode=require&channel_binding=require`——这是 SiteOps 客户端解析所要求的形状。

proxy 的私有接口 `/cplane/get_endpoint_access_control` 与 `/cplane/wake_compute` 已实现并对真 proxy 跑通，后者按需唤醒 idle 的 compute，且在请求线程里主动推进 reconciler（proxy 正阻塞在这个调用上）。

容器里的客户端（比如 Directus）看到的 proxy 是 `host.docker.internal`，端点 id 塞不进这个主机名，用 Neon 的启动包回退参数即可，这条路径不依赖 DNS：

```
postgresql://<role>:<pw>@host.docker.internal:5434/<db>?sslmode=no-verify&options=endpoint%3D<endpoint_id>
```

## 文档

| 文档 | 内容 |
|---|---|
| [001 设计与卡点分析](docs/design/001_Neon_API_v2兼容控制面_设计与卡点分析.md) | 概念映射、架构、三档连接路由、13 项卡点 |
| [002 代码级实施方案](docs/design/002_代码级实施方案.md) | 文件清单、SQL、状态机、函数签名、错误码、测试设计、实测结论 |
| [003 任务分解与验收清单](docs/design/003_任务分解与验收清单.md) | `T-xxx` 任务与验收命令，含完成情况 |
| [M0 pageserver 实测](docs/notes/M0-pageserver-findings.md) | 6 条真机事实（重复建 timeline 幂等、删除异步等） |
| [M0 compute 实测](docs/notes/M0-compute-findings.md) | compute API 的 JWT 合同、spec 三种写法、删角色必须 delta |

`spec/neon-api-v2.json` 是官方 OpenAPI 原样 vendored（`https://neon.com/api_spec/release/v2.json`），**禁止手改**：它是唯一的对外合同来源，所有响应在非生产环境都过它的 schema 校验。

## 架构一句话

一个 Hono 进程 + SQLite 状态 + 三个 adapter（pageserver HTTP、Docker Engine、compute_ctl HTTP）。写操作先落 `operations` 行再由 reconciler 逐步执行，每步幂等、失败退避重试五次、重启从 `cursor_step` 续跑。project 对应一个 pageserver tenant，branch 对应一条 timeline，endpoint 对应一个 compute-node 容器。
