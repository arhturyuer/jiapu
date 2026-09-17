# 有谱

基于微信云开发的家庭协作家谱小程序，包含原生小程序、云函数和 Vue 3/TypeScript 运营后台。

## 开发入口

- [文档索引与处理清单](docs/文档索引.md)：每份文档的用途、有效状态、核验依据和替代入口。
- [当前能力与边界](docs/当前能力与边界.md)：已实现功能及需要核验的事项。
- [开发规范](docs/开发规范.md)：目录职责、接口、兼容性、测试和文档同步要求。
- [设计风格规范](docs/有谱设计风格规范.md)：当前视觉约定及设计目标。
- [环境与 AI 操作规则](AGENTS.md)：后续任务必须遵守的环境和发布职责边界。

## 目录

| 目录 | 职责 |
|---|---|
| `miniprogram/` | 微信小程序；统一通过用户 API 访问业务数据 |
| `cloudfunctions/youpuUserApi/` | 用户 API、家谱权限、事务、内容安全和会员业务 |
| `cloudfunctions/youpuOpsApi/` | 运营 API、白名单、分权和审计 |
| `cloudfunctions/youpuJobs/` | 初始化、维护、导出和审核回调 |
| `cloudfunctions/youpuPaymentNotify/` | 支付通知代码；production 部署目标使用 V2 名称 |
| `cloudfunctions/familyFunctions/` | 遗留代码；调用状态待核验，不作为默认回滚方案 |
| `admin/` | 运营后台 |
| `deployment/` | 环境护栏、部署清单、云端预检与人工上传工具 |
| `scripts/`、`tests/` | 本地检查、生成工具和回归测试 |
| `docs/` | 现行规范、验收说明和明确标记的历史资料 |

## 本地验证

需要 Node.js 20.19+、pnpm；首次安装后台依赖：

```bash
pnpm --dir admin install --frozen-lockfile
bash scripts/check.sh
```

检查无需云端凭据、微信登录或 `env.local.js`，不会自动安装依赖或访问云端。后台构建必须显式指定环境：

```bash
VITE_CLOUDBASE_ENV=<独立staging环境ID> bash scripts/check.sh --build-admin
```

可使用 `NODE_BIN`、`PNPM_BIN` 指定工具路径。直接运行测试也支持无本机环境配置：`node --test tests/*.test.js`。文档检查单独入口：`node scripts/check-docs.mjs`。

## 部署与人工发布

AI 负责服务端部署及验证，人工负责小程序上传、体验版设置、提交审核与发布。完整流程和授权要求见[正式发布运行手册](docs/正式发布运行手册.md)，每次交接使用[版本模板](docs/releases/TEMPLATE.md)。

默认仅允许独立 staging。完成[staging 建立手册](deployment/staging-runbook.md)的本机配置后，首次初始化按以下命令进行；日常部署按改动选择组件：

```bash
./deployment/staging-preflight.sh
./deployment/deploy-staging.sh all
```

小程序开发版 `develop` 连接 staging；体验版 `trial`、正式版 `release` 连接 production；未知版本降级 staging。不要删除本机配置或修改受控环境文件来切换。上传参数只验证路由，不产生独立的 staging 体验包。

production 只允许在当前请求明确授权后操作，并通过原有脚本护栏；“部署”“上线”“验收通过”不能推断为生产授权。生产环境标识以受控配置为准，staging 标识及密钥保存在 Git 忽略的本机配置，生产个人数据不得复制到 staging。

详细部署契约见[开发部署说明](docs/有谱开发部署说明.md)，验收按[发布验收清单](docs/发布验收清单.md)选择适用项目。本地检查成功不代表已部署或已发布。
