# 家庭会员 staging 验收手册

> 文档状态：现行规范。平台配置需每次核验，不能据本文认定已开通；见[文档索引](./文档索引.md)。

## 环境边界

本手册只适用于独立 staging。`youpuUserApi` 与 `youpuJobs` 必须保持 `PAYMENT_MODE=sandbox`，虚拟支付请求固定 `env=1`；`youpuPaymentNotify` 只保留内部调用密钥。只能使用沙箱 OfferID、AppKey、应用凭据和 staging 专用内部密钥，不得填写或复制 production 凭据、数据或域名。开发版小程序是验收入口，沙箱不产生真实资金。

## 部署前检查

1. 按 `deployment/staging-runbook.md` 生成 staging 本地配置并运行 preflight。
2. 部署四个云函数、数据库索引和 deny-all 安全规则；执行 bootstrap 后确认 schema version 为 8。
3. 确认 `payment_orders`、`payment_events`、`membership_grants` 与扩展后的 `export_tasks` 已创建；`commerce_metrics_daily` 已退出活动运行路径，不作为新环境必需集合。
4. 在云开发控制台的“设置 → 其他设置 → 消息推送”中，把 `event/xpay_goods_deliver_notify` 和 `event/xpay_refund_notify` 逐条绑定到 staging 的 `youpuPaymentNotify`，并留存页面截图和函数日志。绑定若会替换 production 目标，必须先获得当前请求的生产授权；不能因 staging 验收而中断生产通知。平台直接向云函数传入 JSON，不配置 HTTP 通知 URL、GET 校验、消息 Token 或 AESKey。每个事件组合同一时间只能绑定一个环境；切换 production 前必须确认 staging 无待确认订单。
5. `youpuJobs` 只保留每日保留期触发器。家庭备份由管理员申请后异步派发；沙箱待确认订单只在用户打开订单并显式重试时以 `env=1` 调用 `query_order`。运营商业指标按打开页面时即时读取，不再周期写入日报集合。
6. 广告开通状态属于待核验的平台事实。家庭、我的及真实与示例家谱人物弹框分别使用 `family`、`profile`、`memberSheet` 广告位；未配置有效广告位 ID 时不应留下广告空白。广告配置以 `miniprogram/config/commerce.js` 和本次平台验收结果为准。

## 端到端验收

1. 使用虚构测试资料创建家谱 A，并邀请第二个 staging 测试账号加入。另建家谱 B 验证权益不串谱。
2. 在“家庭 → 顶部会员标识”进入家庭会员，确认页面明确显示家谱 A、全体家人共享和不可转移；选择 30 天、1 年或永久 SKU 并阅读说明。
3. 分别选择三个 SKU，完成真机微信沙箱支付。页面应调用 `wx.requestVirtualPayment`，订单保存 `paymentMode=sandbox`、`paymentEnv=1`，最终为 `fulfilled`，且同一订单只有一个 active grant。沙箱真机支付仅使用 Android：微信 Apple IAP 不支持 `env=1` 沙箱，iPhone 开发版应明确拦截并提示改用 Android，禁止为此改用 `env=0`。
4. 分别验证云函数消息推送和用户点击“查单重试”均可完成发货；重复推送、重复查单或重复打开订单不得产生第二个 grant 或延长期限。取消支付、未知事件、错误商品/付款人和订单超时必须不发放权益；处理异常时函数应返回非零结果，让平台重试。
5. 用第二个家庭成员账号打开家谱 A：应能查看完整历史；家谱 B 仍为免费家庭且只能查看最近 20 条。
6. 以家谱 A 管理员生成完整备份。确认请求后立即异步启动，检查退避轮询、进度、分卷不超过 100MB、`manifest.json`、CSV 和审核通过图片；离开页面后不得继续查询。通过“下载并转发”调用 `wx.downloadFile` 与 `wx.shareFileMessage`。非管理员必须被拒绝，7 天内再次申请必须被拒绝。
7. 在沙箱后台触发退款通知并确认订单变为 `refunded`；会员期限按其余未退款 grant 重算。若无有效 grant，完整历史分页、备份和去广告权益立即降级。
8. 打开运营后台“商业化”：核对 GMV、退款、SKU、转化、有效会员家庭和月额度；待确认订单只显示“查单重试”，后台不得出现改价、手工改会员或直接退款入口。
9. 有有效 staging 广告位时，分别在非会员与会员身份打开真实家谱人物弹框，并在示例家谱打开弹框；核对横幅展示、会员去广告、广告加载失败后不留空白。无广告位 ID 时仅检查弹框不预留空白，不把广告展示记为通过。

## 生产接入交接（需另行明确授权）

只有后续请求明确授权生产发布后，才可按微信个人主体虚拟支付后台配置三个固定道具、`env=0` 和 production 应用凭据。先确认 staging 不存在待确认订单，再把两条 `event` 消息推送绑定从 staging 切换到 production 的 `youpuPaymentNotifyV2`；不得恢复 HTTP 回调。由人工上传并设置体验版后，Android 与 iOS 分别以 30 天商品完成最低金额真单和真实退款，留存函数消息推送日志、`payment_events`、订单、权益、退款记录与账单一致性证据。production 密钥只能放在 production 环境变量/密钥管理中，禁止写入仓库或 staging。
