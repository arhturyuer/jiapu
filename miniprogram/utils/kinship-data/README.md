# 称谓词表

来源：<https://github.com/mumuy/relationship>，npm `relationship.js@1.2.9`，MIT 许可，见本目录 `LICENSE`。
固定包地址、SHA-512 integrity 和入口文件 SHA-256 记录在 `source.json`。

本项目仅使用开发阶段导出的静态关系编码和首选称谓，不打包或运行上游的自然语言解析、性别推断、关系简化算法。

## 重建

将 npm 发布的 `relationship.js-1.2.9.tgz` 下载到临时目录，先使用 `source.json` 中的 integrity 校验原始压缩包，再解包并运行：

```sh
node scripts/build-kinship-dictionary.js /临时目录/package
```

导出 76,186 条能够用独立、无歧义 token 表达的关系编码。原词表中的选择表达式、关系合称和版权彩蛋不作为某个具体人物的确定称谓。

`dictionary.js` 使用前缀差分存储：每条包含与上一条共享的键前缀长度、键后缀、共享的称谓前缀长度及称谓后缀。键和称谓之间用小写字母表示称谓前缀长度，省去单独的空格；条目用词表中不存在的单字符 `|` 分隔，避免在 JS 字符串中为每条存储双字节换行转义。键前缀长度用 `A` 加长度编码，称谓前缀长度用 `a` 加长度编码；键 token 按 `tokens` 数组编码。中文称谓按 JavaScript 字符串单位求共同前缀。运行时由 `kinship-dictionary.js` 解码一次，并建立只供路径搜索使用的中性前缀集合。

默认称呼在 `kinship.js` 的 `DEFAULT_LABELS` 中覆盖。例如“姑姥”“表舅”“孙媳”“侄孙”采用本项目约定用词；其他关系先按已确认的长幼条件查询，再查询无需长幼条件的条目，不能从多个可能答案中猜一个。
