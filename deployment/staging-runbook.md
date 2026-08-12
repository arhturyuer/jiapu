# 独立 Staging 环境建立与长期使用

## 当前生产盘点（只读记录）

| 项目 | 当前值 |
| --- | --- |
| 生产环境 ID | `cloud1-d5gs5yj4l283d9c6d` |
| 小程序正式构建 | `miniprogram/config/env.js` 默认 `production` |
| 用户 API / 运营 API / 定时任务 | `youpuUserApi` / `youpuOpsApi` / `youpuJobs` |
| 数据访问 | 客户端不得直连数据库；集合基线为 `ADMINONLY` |
| 存储基线 | 个人套餐为 `PRIVATE`；业务仅返回审核通过的临时链接 |

本次改造不读取、不导出、不复制、不清空生产数据；生产 ID 被固化为 staging 写入命令的拒绝目标。

## CloudBase 控制台最少操作

1. 在与生产相同账号下新建一个云开发环境，名称建议 `youpu-staging`；创建后记录**新**环境 ID、数据库实例 ID 和默认存储桶名称。不要选择导入、恢复、迁移或复制生产数据库/存储。
2. 切换到新环境，在“登录授权 / 身份认证”只开启运营后台需要的邮箱密码登录；为 staging 单独创建一个运营测试账号。不要复用生产账号密码、`BOOTSTRAP_SECRET`、第三方密钥或真实用户数据。
3. 在“云函数”或发布页为 `youpuJobs` 设置一个新随机 `BOOTSTRAP_SECRET`，并按 `deployment/cloudbaserc.example.json` 配置三个函数的 Nodejs20.19、内存、超时和两个定时触发器。初次 bootstrap 后立即轮换该密钥。
4. 在新环境配置静态托管并部署 `admin/dist`；若要测试图片审核，再为新环境单独配置 `security.mediaCheckAsync` 回调到 `youpuJobs`，以及 `staging/` 前缀的 24 小时生命周期规则。

除以上四项外，集合、索引、数据库/函数/存储规则由下方脚本部署并回读验证。生产环境无需进行任何控制台操作。

## 本地首次配置

```bash
cp deployment/staging.local.env.example deployment/staging.local.env
```

只在 `deployment/staging.local.env` 中填入步骤 1 的三个新值和一条 staging 专用 `STAGING_BOOTSTRAP_SECRET`；该文件和生成的 `miniprogram/config/env.local.js` 都被 Git 忽略。个人套餐若不支持 `CUSTOM` 存储规则，则明确设置 `STAGING_ALLOW_PERSONAL_PRIVATE_STORAGE=1`，脚本会回读并确认仍为 `PRIVATE`，绝不会回退为公开权限。

```bash
./deployment/staging-preflight.sh
./deployment/deploy-staging.sh all
```

随后执行 `./deployment/deploy-staging.sh bootstrap` 创建空集合；它绝不会导入、复制或清空数据。若需要 staging 运营后台，先在 staging 创建单独的 Auth 用户，把其 UID 作为 `STAGING_INITIAL_OPERATOR_AUTH_UID` 写入本地文件，再运行 bootstrap（或在该账号创建后重跑 bootstrap）。详细请求体见 [开发部署说明](../docs/有谱开发部署说明.md#4-数据初始化)。随后再次执行：

```bash
./deployment/deploy-staging.sh verify
```

## 护栏与日常命令

- **固定执行规则**：未在当前请求中明确写出 `production`、`生产发布` 或 `部署生产` 的任何开发、部署、联调、预览与验收，均视为 staging。"部署"、"上线"、"发布"、"验收通过"不构成生产授权；生产操作必须获得当前请求的明确授权，并满足生产发布手册和脚本确认条件。
- `staging-preflight.sh` 只有在本地生成的配置为 `staging` 且环境 ID 等于 `STAGING_ENV_ID` 时才会继续。
- `deploy-staging.sh`、`uploadCloudFunction.sh`、索引/安全规则/云端验证脚本都要求 `DEPLOYMENT_TARGET=staging` 和 `STAGING_ENV_ID` 一致；目标是生产 ID、占位 ID 或不一致 ID 时立即失败。
- `deploy-staging.sh hosting` 会以 `VITE_CLOUDBASE_ENV=STAGING_ENV_ID` 构建运营后台并部署到该 staging 的静态托管；不要把 staging `dist` 上传至生产静态托管。
- 生产变更必须另行显式使用 `DEPLOYMENT_TARGET=production`、生产 ID 和 `ALLOW_PRODUCTION_CHANGE=1`；staging 命令不能借此写入生产。
- 要切回正式小程序构建，删除本机 `miniprogram/config/env.local.js`（它不在版本控制中），再运行生产预检。不要通过修改受版本控制的 `env.js` 切换环境。

长期测试仅使用虚构姓名、测试图片和 staging 测试账号；不得从生产导出并导入个人资料或家谱数据。需要验证恢复流程时，先在 staging 自己创建的测试数据上演练。
