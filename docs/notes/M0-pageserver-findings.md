# M0 实测记录：pageserver

> 日期 2026-09-07 · 任务 [T-002 / T-003](../design/003_任务分解与验收清单.md) · 环境：Apple Silicon，`docker.io/neondatabase/neon:latest`（arm64/linux，1.88 GB），单 pageserver + 单 safekeeper + MinIO，无 storage_controller  
> 复现：`pnpm compose:up && pnpm test:e2e`，探针 `npx tsx scripts/probe-pageserver.mjs`

## 结论摘要

| # | 问题（002 §14） | 结论 |
|---|---|---|
| 5 | `neon` 镜像在 arm64 上是否可用 | **可用**。`latest` 是 multi-arch，拉下来是 `arm64/linux`，1.88 GB；pageserver 与 safekeeper 都正常起 |
| — | 无 storage_controller 能否工作 | **能**。`pageserver.toml` 里 `control_plane_api='http://0.0.0.0:6666'` + `control_plane_emergency_mode=true`，然后直接 `PUT /v1/tenant/{id}/location_config`（`AttachedSingle`、`generation:1`）即可 |
| 4 | `get_lsn_by_timestamp` 的响应与越界行为 | 返回 `{"lsn":"0/14E8F20","kind":"nodata"}`。**不抛错**：过去（2000 年）与未来（2099 年）都返回同一形状。全新 timeline 没有 WAL，三次调用 `kind` 都是 `nodata`；`present`/`past`/`future` 的区分要等写入数据后再测（留给 T-004 之后） |
| 7 | 删除行为 | `DELETE timeline` 是异步的：返回后 timeline 仍会在列表里短暂存在，需轮询消失（实测 ≤ 512 ms）。`DELETE tenant` 同理 |

## 新发现（002 未曾提出，但影响实现）

1. **重复建同一个 `new_timeline_id` 被接受，不报 409。** 这对 reconciler 的幂等设计是好消息：`create_timeline` step 可以直接重跑，不必先查后建。002 §7.1 里"409 视为 AlreadyExists"的归类保留，但不再是主路径。
2. **`current_logical_size` 直接来自 timeline detail，建表响应里就有。** 全新 v17 timeline 是 23 027 712 字节，`current_logical_size_is_accurate: true`。`Branch.logical_size`（002 T-305）不需要额外的 API。
3. **`createTimeline` 的响应就是完整 `TimelineInfo`（31 个字段）**，建完不用再 `GET`。关键字段：

   ```
   tenant_id, timeline_id, ancestor_timeline_id, ancestor_lsn, last_record_lsn, prev_record_lsn,
   applied_gc_cutoff_lsn, min_readable_lsn, disk_consistent_lsn, remote_consistent_lsn,
   remote_consistent_lsn_visible, initdb_lsn, current_logical_size, current_logical_size_is_accurate,
   directory_entries_counts, current_physical_size, current_logical_size_non_incremental,
   pitr_history_size, within_ancestor_pitr, timeline_dir_layer_file_size_sum, wal_source_connstr,
   last_received_msg_lsn, last_received_msg_ts, pg_version, state, walreceiver_status,
   is_archived, rel_size_migration, rel_size_migrated_at, is_invisible
   ```

4. **LSN 形如 `0/14E8F98`**（`%X/%X`）。分支时把父的 `last_record_lsn` 原样传给 `ancestor_start_lsn`，响应里回显为 `ancestor_lsn`（注意两个字段名不同：请求 `ancestor_start_lsn`，响应 `ancestor_lsn`）。
5. **`min_readable_lsn` 与 `applied_gc_cutoff_lsn` 是 PITR 窗口的下界。** 按时间建分支越界时，与其依赖 `kind`，不如自己比较 `ancestor_start_lsn >= min_readable_lsn`，越界直接返回 `WRONG_LSN_OR_TIMESTAMP`——这条更可靠，写进 002 §5.2。
6. **不存在的 tenant 返回 404**，adapter 归类为 `not_found` 已验证。

## 待续（需要先有 compute 才能测）

- `kind` 在有 WAL 之后的取值（`present` / `past` / `future`），以及跨过 `pitr_interval` 的行为。
- tenant 删除时残留 timeline 的处置（002 §14 第 7 条的后半段）。
