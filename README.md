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
node --test tests/*.test.js
cd admin && pnpm install --frozen-lockfile
VITE_CLOUDBASE_ENV=<预发布环境ID> pnpm run build
/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  --project <项目绝对路径> --qr-format terminal
```

正式预检使用：

```bash
TARGET_ENV_ID=<预发布环境ID> ./deployment/preflight.sh
```

预检会主动阻止以下情况：仍使用占位主体、环境未显式切换、管理端构建失败、测试失败或微信预览失败。

## 环境安全

当前生产环境为 `cloud1-d5gs5yj4l283d9c6d`，代码仓库不会自动清空它。必须先在 CloudBase 控制台创建独立预发布环境，完成索引、安全规则、云函数、内容审核回调、运营登录和全量验收；随后对生产数据库与存储清单做可恢复备份，才允许生产初始化。

详细步骤见[开发部署说明](./docs/有谱开发部署说明.md)、[正式发布运行手册](./docs/正式发布运行手册.md)和[发布验收清单](./docs/发布验收清单.md)。
