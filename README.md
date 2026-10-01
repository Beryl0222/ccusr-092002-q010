# 循环租用履约风控 — 租赁策略实验服务

管理数码与户外设备的验机、信用免押、物流交接、损伤争议和循环寿命。

本服务为“提前预授权 / 分层保障计划 / 按时归还奖励”等策略提供**在线实验能力**，替代
“全站改规则再看坏账”的旧做法：设备缺货、节假日需求、不同成色设备不再与策略效果混在一起。

`contracts/rental_asset.json` 保存公开的领域样例与资产目录（类别、成色、配件、所在仓、
可租状态与验机记录），用来约定外部数据的名称与层级；样例不含真实个人资料、业务凭据或
生产连接信息。

## 运行

```bash
npm run check   # 服务身份 + 资产目录自检
npm test        # 全量契约与域测试
npm start       # 启动 HTTP 服务（默认 :8000，--port 可改）
```

启动后 `/health` 返回项目标识。

## 设计原则（与业务约束一一对应）

| 业务要求 | 实现位置 / 机制 |
| --- | --- |
| 从资产文件读取类别、成色、配件、所在仓 | `src/catalog.js`：`Catalog.load()`，分组只信目录状态 |
| 仅在资产可租且用户合规时稳定分组 | `evaluateEligibility`：全部不满足原因一次性留痕，不短路；分组键为 `sha256(experiment_id|user_id)`，与库存、随机数无关 |
| 同一用户/资产不能同时进入互相污染的实验 | 实验声明 `mutex_group`；用户维度与资产维度双重互斥检查（`findMutexConflict`） |
| 续租保留原分组与暴露区间 | `renewal_of` 无条件沿用原臂，追加 `renewal_segments` 续期段并延长 `exposed_through`，续租新合同号的事件自动归并原曝光；换人/换资产被拒绝 |
| 跨仓调拨不篡改历史 | 调拨只改目录当前仓位；历史曝光保存 `origin.warehouse` 快照 |
| 策略中途停止保留原分组 | 停止后拒绝一切新分组；续租即使在停止后也沿用原臂，该续期段打 `post_stop` 单独计数、不进入主分析窗口 |
| 下单/取消/逾期/损伤争议/复租幂等汇入 | 事件以 `event_id` 去重；结果在报告生成时按曝光折叠 |
| 异常批量账号 / 客服豁免 / 缺验机单独标记 | `account_flag`、`cs_exemption` 事件与 `missing_inspection` 资格标志；样本**保留在主口径**，另出 `clean_only` 敏感性视图，绝不静默删除 |
| 匹配不到的事件不丢弃 | 进入隔离区（quarantine）并计入报告数据质量；曝光日后出现时自动补配 |
| 分析人员发布指标口径后才能冻结 | `publishMetricDefinition` → `freezeExperiment` 门禁，缺口径直接拒绝 |
| 迟到事件带版本重算，不覆盖旧报告 | 冻结后事件触发 `late_event` / `post_freeze_event` 新版本；历史版本永久可查 |
| 运营只看到满足隐私阈值的结果 | 指标口径含 `privacy_threshold`（最小单元 n），低于阈值掩码；运营在冻结前看不到报告 |
| 结论附资格、排除原因、仓库/时间分层、不确定性 | 报告含 `cohort.excluded`、`quality_flagged`、仓/成色/类别/月份分层、Wilson 区间与 Newcombe 差值区间 |
| 负责人据此推广/回滚/继续观察，不干预单笔租赁 | 报告输出确定性 `recommendations` 与护栏告警，并附 `scope_note`；服务不提供按单笔租赁改分组的接口 |

## HTTP 接口

角色通过 `x-role: analyst | operator` 头区分（默认 operator）。

- `POST /v1/experiments`（analyst）— 创建实验：臂、流量桶区间、互斥组、定向、合规门槛
- `GET  /v1/experiments` / `GET /v1/experiments/{id}`
- `POST /v1/experiments/{id}/stop` / `freeze`（analyst）
- `POST /v1/experiments/{id}/assignments` — 分组；续租带 `renewal_of`；不合格返回 422 与排除原因
- `POST /v1/experiments/{id}/metrics/definitions`（analyst）— 发布指标口径（带版本）
- `POST /v1/experiments/{id}/reports/recompute`（analyst）— 生成新版本报告
- `GET  /v1/experiments/{id}/reports` / `reports/latest` / `reports/versions/{n}`
- `GET  /v1/experiments/{id}/eligibility-trail`、`/exposures`（analyst）
- `POST /v1/events` — 幂等汇入：单条事件返回该事件的处理结果，`{events:[...]}` 批量返回 `{results:[...]}`
- `POST /v1/assets/{assetId}/transfers` — 跨仓调拨

指标口径可用指标：`cancel_rate`、`overdue_rate`、`bad_debt_rate`、`damage_dispute_rate`、`rerent_rate`；
`guardrails` 中的指标若相对对照组显著恶化（区间不跨 0），会阻止“推广”建议。

## 代码结构

```
src/hash.js        稳定哈希与分桶
src/catalog.js     资产目录（rental_asset.json）
src/experiment.js  实验生命周期、资格、互斥、幂等事件、冻结门禁、版本化报告
src/metrics.js     Wilson/Newcombe 区间、分层、隐私掩码、决策建议
src/api.js         HTTP 路由与角色控制
src/service.js     入口：/health + 实验服务
```
