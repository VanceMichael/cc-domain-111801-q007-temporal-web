# TemporalWeb 来源约定

此服务管理历史观察协商、时点引用解释及订单历史包接收。
当前常规业务使用一个选定来源上下文处理直接列出的记录。目录请求为 `GET /web/current`，返回 `site` 与 `pages`。每个目录成员以 `id`、`href` 提供来源身份与原文位置，原文中的 `page` 和 `site` 必须与目录一致。

## 记录含义

```json
{
  "page": "PAGE1",
  "site": "shop-a",
  "url": "https://shop.invalid/terms",
  "observedAt": "2026-11-01T09:00:00Z",
  "title": "运输说明",
  "body": "本地区运费以订单确认页为准"
}
```

这里的字段是来源提供的原始声明，数值文本必须符合十进制规则，不能把空白或未知值转换成零。领域解释保留站点页面身份、实际观察时间、同观察内容冲突。只有所选范围内且有充分常规依据的记录列入当前收件；其他范围、待确认、历史和冲突分别保留结果，不用覆盖旧原文消除分歧。

## 本地合作源

`fixtures/source.json` 的 `resources` 是本地来源的 URL 路径到响应正文的映射；只绑定回环地址，不连接真实监管、银行或合作方。原文可通过目录声明的位置取得。同一来源也可发布关联资料，当前示例的关联资料位置为 `/web/current/relations/PAGE1`，字段保留来源的业务含义：

```json
{
  "period": [
    "2026-10-01",
    "2026-11-01"
  ],
  "archive": "/archive/timegate",
  "references": [
    {
      "page": "zones",
      "edition": "v4"
    }
  ]
}
```

`fixtureSource` 支持独立实例、指定路径返回码、一次性来源故障、响应延迟与 `replace` 更新资源；访问记录保留实际请求路径，不凭空生成未收到的响应。目录不承诺所有关联资料与当前目录同时发布；HTTP 404、403、503 不能自行解释为业务删除。

## 历史时点协商

日常领取只覆盖当前目录中的页面；处理历史订单争议时，必须按订单时点协商历史观察，而不是取一个日期最接近的当前正文。协商所需的发布周期、归档来源与引用关系由关联资料声明，支持多周期、多归档来源：

```json
{
  "periods": [
    { "start": "2026-10-01", "end": "2026-11-01" },
    { "start": "2026-11-01", "end": "2026-12-01" }
  ],
  "archives": [
    { "source": "archive-a", "timegate": "/archive/a/gate" },
    { "source": "archive-b", "timegate": "/archive/b/gate" }
  ],
  "references": [
    { "page": "zones", "edition": "v4" }
  ]
}
```

周期为半开区间 `[start, end)`，订单时点不落在任何周期内时返回 `outside-cycle`，不发起归档协商，也不用当前页顶替。旧版单周期字段 `period`/`archive` 仍被解释为一个周期、一个归档来源。

### TimeGate 协商约定

对每个归档来源发起 `GET {timegate}?url={历史网址}&at={订单时点}`，附表协商额外带 `edition={引用版本}`。响应只描述该来源能提供什么：

```json
{
  "source": "archive-a",
  "location": "/archive/a/memento/body/2026-10-20T08:00:00Z",
  "candidates": [
    { "observedAt": "2026-10-05T08:00:00Z" },
    { "observedAt": "2026-10-20T08:00:00Z" }
  ]
}
```

`candidates` 列出该周期内的全部候选观察；若候选多于一个而 `location` 只指向较近一版，历史包标记 `ambiguous`——只拿到近版不能声称另一版不存在。取回的 memento 必须通过三项校验：历史网址与协商目标一致（站点迁移后的当前重定向返回 `identity-mismatch`，重定向不构成历史身份依据）、观察时刻落在订单所属周期窗口内、附表 `edition` 与正文引用完全一致（不符为 `edition-rejected`，缺档为 `appendix-missing`，禁止用时间更近的不同版顶替）。

### 多来源综合与时间字段

多个归档来源的结果按内容摘要与观察时刻综合：同观察时刻同内容相互印证；同观察时刻不同内容为 `conflict`；不同观察时刻为 `divergent`。全部来源都未给观察时为 `unavailable`（附表为 `appendix-missing`），来源空缺只如实报告 HTTP 状态，不推断“当时没有该条款”。

三个时间字段严格区分，禁止互相伪装：

- `requestedAt`：本次协商请求发出的时间；
- `retrievedAt`：原文实际取得的时间（来自本机时钟）；
- `observedAt`：归档站声明的页面捕获时间，只取自 memento 正文，绝不用请求时间顶替。

历史包的每个组件都带归档来源 `source` 与原文摘要 `digest`。

## 原文和收件

原文字节按 SHA-256 寻址，SQLite 保存来源位置、观察时间、收件范围、业务身份、领域记录与决策。收到原文不等于领域接收成功；重复的同一内容不新增收据，同一身份的不同内容不会覆盖原件。`.data/` 仅用于本机数据，演示使用临时目录，运行结束关闭服务并清理临时状态。

历史协商另有两张只追加表：`history_negotiations` 逐来源记录每次协商（含失败原因、请求/取得时间、摘要），`history_packages` 按订单身份保存成套结论。一次失败的重新协商只会新增留痕，既不覆盖已保存的历史包，也不删除或替换任何已寻址原件。
