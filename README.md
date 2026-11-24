# TemporalWeb

TemporalWeb 为业务资料员提供历史观察协商与原文保管，已支持来源目录预览、直接记录领取、站点页面身份、实际观察时间、同观察内容冲突以及按业务范围形成收件记录。原文与领域收件结论分开保存，便于复查来源内容。

新增按订单时点的历史采集：以订单所属站点的发布周期为允许窗口，向合作归档站协商正文观察，并按正文明确引用的版本取得地区附表；形成时间与引用关系均可说明的历史包，可区分正文无合适观察、附表缺档与归档来源相互矛盾。协商失败不覆盖既有历史原文，查询返回实际取得时间与归档来源。

## 环境与运行

使用 Node.js 22.23.4，依赖版本由 `package-lock.json` 固定。仅使用 Node.js 内置模块，无需外部数据库进程或第三方运行服务。

```sh
npm ci
npm run build
npm test
npm run demo
```

`npm run demo` 在本机启动合作源与合作归档站，用独立临时目录完成真实领取、原文保存、领域接收与两笔历史订单的按时点采集，输出实际结果后清理；不要求外网资料。`npm start` 可单独启动本地来源供交互查看，终端会打印实际回环地址，Ctrl-C 关闭。通过 `PORT` 指定监听端口，省略或设置为 `0` 时自动分配；仅监听回环地址。根路径返回可用资源目录与运行状态。

## 容器

```sh
docker build -t temporal-web:local .
docker run --rm --network none temporal-web:local
```

镜像构建时准备依赖，容器运行时不联网，演示只使用回环通信。可改用 `docker run --rm --network none temporal-web:local npm test` 运行回归。存储通过 `Archive` 传入本机目录，不包含生产账号、真实业务资料或凭据。

## 代码与来源约定

`src/source.mjs` 负责来源目录与原文身份，`src/interpret.mjs` 解释当前领域记录，`src/receiving.mjs` 决定选定范围内的收件结果。`src/historical.mjs` 解释关联资料、历史观察与历史包状态，`src/timegate.mjs` 负责归档站的时点协商，`src/app.mjs` 连接日常业务与按订单时点的历史采集。`src/archive.mjs` 提供原文保管及收据落库，`fixtures/`、`src/fixture-source.mjs` 与 `src/fixture-archive.mjs` 提供可独立复查的本地合作源与合作归档站。详细字段与来源声明见 `docs/source-contract.md`。
