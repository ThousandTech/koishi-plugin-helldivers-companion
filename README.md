# Koishi Helldivers Companion

Companion 截图、页面翻译、官方中文文本预取和频道新闻 / MO 订阅插件。支持新闻、首页、DSS、星球详情、重要指令页和 MO 弹窗截图。

## Koishi 安装

安装并启用 `koishi-plugin-puppeteer`，再加载本插件。Puppeteer 服务负责浏览器生命周期；插件会为每次截图创建并关闭独立页面。系统必须可找到 Chrome/Chromium。

命令：

- `hd2.news` / `hd2.home` / `hd2.dss` / `hd2.overview` / `hd2.mo`
- `hd2.planet <中文/英文星球名、编号、slug 或 Companion URL>`
- `hd2.test <页面类型> [星球目标]` 强制重新截图

以上命令开始处理时会立即发送“收到指令，正在处理，请稍候。”，随后发送原有结果或错误消息。自动订阅推送不发送此回执。

## MO 订阅

管理员开启 `subscriptionEnabled` 后，通过 `subscriptionNewsChannels` 和 `subscriptionMoChannels` 分别配置新闻与最高指令推送频道。频道格式为 `平台:频道ID`（如 `onebot:123456`）；空数组表示不订阅该类型。插件不提供聊天指令修改订阅。

两类订阅共用 `subscriptionIntervalSeconds`（默认 300 秒，最低 60 秒）。去重指纹保存到 `cacheDir/subscriptions.json`。首次运行只建立基线，不补发历史消息；之后 MO 消息 ID、标题或正文变化时强制截图并推送当前整组 MO。消息重排、战争进度及计时变化不会触发推送，空队列不发送截图。重启保留指纹，可检测停机期间的变化。

API、截图或投递失败会在下轮重试，两类轮询相互隔离，同类型不重叠执行。多个频道中部分投递成功后出现失败，重试可能让已成功频道再次收到相同内容。

## PowerShell 独立测试

```powershell
npm install
npx puppeteer browsers install chrome
npm run hd2 -- screenshot overview
npm run hd2 -- screenshot mo
npm run hd2 -- screenshot planet "meissa_(268)"
npm run hd2 -- fetch all
npm run hd2 -- translate "MAJOR ORDER ADJUSTMENT"
```

命令无需 Koishi 进程。可用 `$env:HD2_CONFIG = '.\hd2.config.json'` 指定 JSON 配置文件；其中 `executablePath` 可显式指定 Chrome 路径。生产环境中 Puppeteer 服务自身的浏览器配置负责启动，插件的 `executablePath` 仅用于 CLI。

## 配置

核心字段：`apiBase`、`planetApiBase`、`planetApiClient`、`planetApiContact`、`planetApiTimeout`、`planetCacheTtl`、`warId`、`apiTimeout`、`cacheDir`、`screenshotCacheTtl`、`screenshotWaitMs`、`pageLoadTimeout`、`translationEnabled`、`translationMode`、`translationApiUrl`、`translationApiKey`、`translationModel`、`translationTimeout`、`translationTargetLang`、`translationMaxTokens`、`translationBatchTimeout`、`translationBudget`、`translationErrorCooldown`、`translationFallbackTtl`、`subscriptionEnabled`、`subscriptionIntervalSeconds`、`subscriptionNewsChannels`、`subscriptionMoChannels`。

星球中文名通过官方译名表反查英文名，再从 `planetApiBase` 获取的战争星球数据匹配并补上 Companion 详情路由要求的编号后缀。星球列表保存在 `cacheDir/planets.json`，默认每 6 小时尝试刷新；刷新超时或失败时继续使用最后一次成功缓存，重启后仍然有效。带编号的 Companion 链接和英文 slug 无需星球 API 即可直达。多个模糊匹配会返回候选星球及编号。

三类官方 API 使用 `Accept-Language: zh-hans` 和 `X-Super-Client: 1.0`，不需要身份认证。截图翻译会优先使用官方中文响应、内置静态短语和术语表，其他英文片段按批次翻译并缓存在 `cacheDir/translations.json`。单批前台等待默认 20 秒，总等待预算默认 60 秒；超时任务继续在后台更新译文缓存。译文不完整时不覆盖完整截图缓存，若有两小时内的旧截图则优先返回旧图。`translationErrorCooldown` 和 `translationFallbackTtl` 默认分别为 120 秒和 180 秒。API Key 不应提交到仓库。

上述新增时间配置的单位均为毫秒。译文缓存最多 4096 条，按模型、接口、目标语言和翻译协议指纹隔离；Companion 翻译失败不写成功缓存，失败记录兼容读取时按 `translationFallbackTtl` 过期。未完整翻译的截图使用独立临时文件，在后续截图时清理超过 24 小时的临时图。`assets/glossary` 的四份词表来自 AstrBot 插件，运行时无需 Python。首次升级会使用新的截图缓存命名空间，旧截图不会被误当成完整译文缓存。
