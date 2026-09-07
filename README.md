# 有谱

有谱是一款基于微信云开发的家庭协作家谱小程序，产品原则是“一个人快速创建，一家人共同补全，由少数管理员维护秩序”。用户默认查看完整家谱，也可以随时从任意人物视角理解亲属关系，不需要认领身份。

## 已实现范围

- 原生微信小程序：建谱、全谱/人物视角、分支折叠、搜索、人物维护、修改审核、邀请与撤销、角色管理、管理员转让、退出、归档恢复、举报、隐私中心、信息导出和注销冷静期。
- `youpuUserApi`：小程序唯一业务入口，包含角色校验、游标分页、事务、幂等、限流、关系校验、文本/图片审核和私有媒体短链。
- `youpuOpsApi`：运营后台唯一数据入口，包含白名单鉴权、两级运营角色、脱敏查询、受控查看、举报/复核/注销工单、冻结和审计。
- `youpuJobs`：定时维护、邀请过期、注销匿名化、归档清理、内容审核回调、临时数据清理和恢复清单。
- Vue 3 + TypeScript 运营后台：登录、概览、用户、家谱、举报、内容复核、注销、审计和运营账号八类能力。

## 目录

- `miniprogram/`：小程序用户端。
- `cloudfunctions/youpuUserApi/`：用户 API。
- `cloudfunctions/youpuOpsApi/`：运营 API。
- `cloudfunctions/youpuJobs/`：内部任务。
- `cloudfunctions/familyFunctions/`：仅用于切换期回滚的旧 API，稳定后关闭调用。
- `admin/`：运营管理端。
- `deployment/`：安全规则、索引、云函数配置样例和发布预检。
- `tests/`：领域规则、静态契约和 500 人图谱性能测试。
- `docs/`：产品、设计、部署和发布文档。

## 本地验证

需要 Node.js 20.19+、pnpm 和微信开发者工具 CLI。

```bash
./deployment/staging-preflight.sh
node --test tests/*.test.js
cd admin && pnpm install --frozen-lockfile
VITE_CLOUDBASE_ENV=<staging 环境ID> pnpm run build
/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  --project <项目绝对路径> --qr-format terminal
```

独立 staging 初始化与预检使用：

```bash
cp deployment/staging.local.env.example deployment/staging.local.env
./deployment/staging-preflight.sh
./deployment/deploy-staging.sh all
```

staging 命令要求独立环境 ID，且对生产 ID、占位 ID 和不一致的目标一律失败。生产预检必须显式设置 `PREFLIGHT_MODE=production`、`TARGET_ENV_ID=cloud1-d5gs5yj4l283d9c6d` 和 `ALLOW_PRODUCTION=1`。

小程序包根据微信官方 `wx.getAccountInfoSync().miniProgram.envVersion` 在运行时选择环境：开发版 `develop` 连接 staging，体验版 `trial` 与正式版 `release` 连接 production；未知值安全降级到 staging。因此体验版和正式发布均会连接 production，发布前必须先完成 staging 验收。

每次上传前，先在 `miniprogram/config/release-notes.js` 的首项新增 `{ version, summary }` 版本记录；上传脚本会校验版本号并自动使用该摘要作为微信后台上传描述。

```bash
bash deployment/upload-miniprogram.sh staging <版本号>
```

仅在明确获准正式发布后，才上传待发布版本并提交审核：

```bash
bash deployment/upload-miniprogram.sh production <版本号>
```

`staging` / `production` 参数用于上传前验证预期运行版本，不再生成不同环境的代码包。禁止删除 `miniprogram/config/env.local.js` 或修改受版本控制的 `miniprogram/config/env.js` 来切换环境。

## 环境安全

> **强制操作规则**：除非当前请求明确写出 `production`、`生产发布` 或 `部署生产`，所有云开发相关的开发、部署、联调、预览和验收均默认且仅能在 **staging** 执行。即使请求写有“部署”“上线”“发布”或“验收通过”，也不得推断为生产授权。生产变更必须由用户在当前请求明确确认，并通过生产脚本护栏。此规则同时写入仓库根目录 [`AGENTS.md`](./AGENTS.md)，供后续 Codex 任务执行。

生产环境为 `cloud1-d5gs5yj4l283d9c6d`。staging 环境 ID 不进入仓库，而由被忽略的本地配置注入；生产数据、密钥和真实个人资料不得复制到 staging。

详细步骤见[staging 建立手册](./deployment/staging-runbook.md)、[开发部署说明](./docs/有谱开发部署说明.md)和[正式发布运行手册](./docs/正式发布运行手册.md)。
