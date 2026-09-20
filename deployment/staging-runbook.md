# 独立 Staging 环境建立与长期使用

> 文档状态：现行规范。以下为仓库目标契约，不是本轮云端盘点。入口见[文档索引](../docs/文档索引.md)。

## 环境目标契约

| 项目 | 仓库约定值 |
| --- | --- |
| 生产环境 ID | `cloud1-d5gs5yj4l283d9c6d` |
| 小程序运行时路由 | `develop` → staging；`trial` / `release` → production |
| 用户 API / 运营 API / 定时任务 / 支付通知 | `youpuUserApi` / `youpuOpsApi` / `youpuJobs` / production：`youpuPaymentNotifyV2`（staging：`youpuPaymentNotify`） |
| 数据访问 | 客户端不得直连数据库；集合基线为 `ADMINONLY` |
| 存储基线 | 个人套餐为 `PRIVATE`；业务仅返回审核通过的临时链接 |

staging 操作不读取、不导出、不复制、不清空生产数据；生产 ID 被固化为 staging 写入命令的拒绝目标。

## CloudBase 控制台最少操作

1. 在与生产相同账号下新建一个云开发环境，名称建议 `youpu-staging`；创建后记录**新**环境 ID、数据库实例 ID 和默认存储桶名称。不要选择导入、恢复、迁移或复制生产数据库/存储。
2. 切换到新环境，在“登录授权 / 身份认证”只开启运营后台需要的邮箱密码登录；为 staging 单独创建一个运营测试账号。不要复用生产账号密码、`BOOTSTRAP_SECRET`、第三方密钥或真实用户数据。
3. 为 `youpuJobs` 准备一个新的 staging 专用 `BOOTSTRAP_SECRET`，生成清单时同一随机值也作为仅限 user API → jobs 的 `JOB_DISPATCH_SECRET`，但两边变量职责独立。四个函数的 Nodejs20.19、内存、超时和唯一的每日保留触发器由部署清单配置；家庭备份保留 `youpuJobs` 的 900 秒任务超时。确认 user API 的运行角色允许异步调用同环境 `youpuJobs`。初次 bootstrap 后轮换时必须同时更新两端派发密钥。
4. 在微信公众平台的“虚拟支付”沙箱中配置三个 SKU，并准备沙箱 OfferID、AppKey、应用凭据和独立的内部调用密钥；不要使用 production 域名、OfferID 或 AppKey。函数部署完成后，在云开发控制台“设置 → 其他设置 → 消息推送”中，将 `event/xpay_goods_deliver_notify` 与 `event/xpay_refund_notify` 分别绑定到 staging 的 `youpuPaymentNotify`。平台会直接向该函数投递 JSON；不配置 HTTP 通知 URL、消息 Token 或 AESKey。
5. 在新环境配置静态托管并部署 `admin/dist`；测试图片审核时为新环境配置 `security.mediaCheckAsync` 回调到 `youpuJobs`。不要设置整个 `staging/` 对象前缀的 24 小时删除规则：审核通过图片也保留在该路径，详见[存储边界](../docs/有谱开发部署说明.md#5-索引与安全规则)。

AI 通过脚本完成获授权 staging 的函数、集合、索引、规则和后台交付，并执行回读；平台专属操作由人工配合。消息绑定可能影响其他环境，切换前须确认现有目标和待确认订单；若会更改 production 绑定，必须有当前请求明确授权。

## 本地首次配置

```bash
cp deployment/staging.local.env.example deployment/staging.local.env
```

只在 `deployment/staging.local.env` 中填入步骤 1 的环境值、staging 专用 `STAGING_BOOTSTRAP_SECRET`，以及步骤 4 的 `STAGING_VP_*` 沙箱变量（包括 `STAGING_VP_INTERNAL_NOTIFY_SECRET`）。该文件和生成的 `miniprogram/config/env.local.js` 都被 Git 忽略；部署日志不会打印变量值。`STAGING_PAYMENT_MODE` 必须固定为 `sandbox`。个人套餐若不支持 `CUSTOM` 存储规则，则明确设置 `STAGING_ALLOW_PERSONAL_PRIVATE_STORAGE=1`，脚本会回读并确认仍为 `PRIVATE`，绝不会回退为公开权限。

```bash
./deployment/staging-preflight.sh
./deployment/deploy-staging.sh all
```

`all` 已包含 bootstrap，无需机械重复执行；bootstrap 幂等创建缺失集合并写入 schema，不导入、复制或清空业务数据。若需要 staging 运营后台，先在 staging 创建单独的 Auth 用户，把其 UID 作为 `STAGING_INITIAL_OPERATOR_AUTH_UID` 写入本地文件，再运行 bootstrap（或在该账号创建后重跑 bootstrap）。详细请求体见 [开发部署说明](../docs/有谱开发部署说明.md#4-数据初始化)。随后再次执行：

```bash
./deployment/deploy-staging.sh verify
```

日常按改动选择 `functions/indexes/security/hosting` 并执行 `verify`；`bootstrap` 仅在需要初始化时执行。`verify` 检查函数运行配置，索引/规则由各应用脚本回读，后台和平台事件还需要对应冒烟验收。

## 护栏与日常命令

- **固定执行规则**：未在当前请求中明确写出 `production`、`生产发布` 或 `部署生产` 的任何开发、部署、联调、预览与验收，均视为 staging。"部署"、"上线"、"发布"、"验收通过"不构成生产授权；生产操作必须获得当前请求的明确授权，并满足生产发布手册和脚本确认条件。
- `staging-preflight.sh` 只有在本地生成的配置为 `staging` 且环境 ID 等于 `STAGING_ENV_ID` 时才会继续。
- `deploy-staging.sh`、`uploadCloudFunction.sh`、索引/安全规则/云端验证脚本都要求 `DEPLOYMENT_TARGET=staging` 和 `STAGING_ENV_ID` 一致；目标是生产 ID、占位 ID 或不一致 ID 时立即失败。
- `deploy-staging.sh functions` 部署清单中的四个云函数，其中支付通知使用 `youpuPaymentNotify`；消息推送绑定必须由云开发控制台人工完成。每个 `event/xpay_goods_deliver_notify`、`event/xpay_refund_notify` 组合一次只能绑定一个环境/函数，因此必须先完成 staging 验收、处理完待确认订单，再切换至 production；不要创建或恢复 HTTP 支付路由。
- `deploy-staging.sh hosting` 会以 `VITE_CLOUDBASE_ENV=STAGING_ENV_ID` 构建运营后台并部署到该 staging 的静态托管；不要把 staging `dist` 上传至生产静态托管。
- 生产变更必须另行显式使用 `DEPLOYMENT_TARGET=production`、生产 ID 和 `ALLOW_PRODUCTION_CHANGE=1`；staging 命令不能借此写入生产。
- AI 不执行小程序上传、提审或发布。人工使用上传工具；小程序使用微信官方 `miniProgram.envVersion` 自动路由：开发版（`develop`）使用 staging，体验版/正式版（`trial` / `release`）使用 production，未知值降级 staging。`./deployment/upload-miniprogram.sh {staging|production} <版本号>` 会验证最新版本记录与上传版本一致，并使用其更新摘要作为上传描述。不得删除配置后依赖默认 production，也不要通过修改受版本控制的 `env.js` 切换环境。

长期测试仅使用虚构姓名、测试图片和 staging 测试账号；不得从生产导出并导入个人资料或家谱数据。需要验证恢复流程时，先在 staging 自己创建的测试数据上演练。

家庭会员的 staging 验收步骤见 [家庭会员 staging 验收手册](../docs/家庭会员staging验收手册.md)。
