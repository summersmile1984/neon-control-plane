# 实现子集

相对官方 spec `neon-api-v2.json`（OpenAPI 3.0.3，122 条路径）实现 30 条；"SiteOps 使用"指 `packages/provider-neon` / `apps/neon-provider-service` 当前调用的路径。

M5（design 004）补齐了鉴权与 API key 管理面：`/api_keys`、组织/项目 scoped key、`/auth`、`/users/me`、`/organizations` 与成员，均按官方 schema 校验。

## Key 与身份

| 路径 | 方法（spec） | 里程碑 | SiteOps 使用 |
|---|---|---|---|
| `/api_keys` | GET / POST | M5 | 否 |
| `/api_keys/{key_id}` | DELETE | M5 | 否 |
| `/organizations/{org_id}/api_keys` | GET / POST | M5 | 否 |
| `/organizations/{org_id}/api_keys/{key_id}` | DELETE | M5 | 否 |
| `/auth` | GET | M5 | 否 |
| `/users/me` | GET | M5 | 否 |
| `/users/me/organizations` | GET | M5 | 否 |
| `/organizations/{org_id}` | GET | M5 | 否 |
| `/organizations/{org_id}/members` | GET | M5 | 否 |
| `/organizations/{org_id}/members/{member_id}` | GET / PATCH / DELETE | M5 | 否 |

## 资源

| 路径 | 方法（spec） | 里程碑 | SiteOps 使用 |
|---|---|---|---|
| `/projects` | GET / POST | M0 | 否 |
| `/projects/{project_id}` | GET / PATCH / DELETE | M0 | 是 |
| `/projects/{project_id}/operations` | GET | M0 | 是 |
| `/projects/{project_id}/operations/{operation_id}` | GET | M0 | 是 |
| `/projects/{project_id}/branches` | POST / GET | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}` | GET / DELETE / PATCH | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/set_as_default` | POST | M1 | 否 |
| `/projects/{project_id}/branches/{branch_id}/endpoints` | GET | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/databases` | GET / POST | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/databases/{database_name}` | GET / PATCH / DELETE | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/roles` | GET / POST | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/roles/{role_name}` | GET / DELETE | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password` | POST | M1 | 是 |
| `/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reveal_password` | GET | M1 | 是 |
| `/projects/{project_id}/connection_uri` | GET | M1 | 是 |
| `/projects/{project_id}/endpoints` | POST / GET | M1 | 是 |
| `/projects/{project_id}/endpoints/{endpoint_id}` | GET / DELETE / PATCH | M1 | 是 |
| `/projects/{project_id}/endpoints/{endpoint_id}/start` | POST | M3 | 否 |
| `/projects/{project_id}/endpoints/{endpoint_id}/suspend` | POST | M3 | 否 |
| `/projects/{project_id}/endpoints/{endpoint_id}/restart` | POST | M3 | 否 |
