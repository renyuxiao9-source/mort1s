# 汇流 · Termux API 网关

在手机上把多个上游渠道接到同一个 OpenAI 兼容地址。客户端调用固定的模型别名，网关按你配置的顺序尝试上游模型。

## 在 Termux 启动

把 `termux-api-hub.zip` 下载到手机的 Download 目录。在 Termux 执行以下命令，按系统提示授权共享存储访问。

```sh
pkg update
pkg install nodejs-lts unzip
termux-setup-storage
cd "$HOME"
unzip -n "$HOME/storage/downloads/termux-api-hub.zip"
cd "$HOME/api-hub"
node server.mjs
```

要求 Node.js 22 或更高版本。项目没有 npm 依赖。默认监听 `127.0.0.1:8787`，可通过 `HUB_PORT=8788 node server.mjs` 更改端口。关闭进程后，客户端需要等服务重启。希望手机锁屏后继续运行时，可以在 Termux 执行 `termux-wake-lock`，并按需调整系统对 Termux 的电池限制。

## 配置第一个别名

1. 用手机浏览器打开 `http://127.0.0.1:8787/`，粘贴首次启动时终端打印的 **管理 Key**。
2. 在 **渠道** 添加上游凭据。已内置 Google AI Studio、OpenAI、DeepSeek、OpenRouter、Anthropic 兼容接口，可添加自定义的 OpenAI Chat Completions 渠道。自定义 Base URL 填接口前缀，例如 `https://example.com/v1`。
3. 在 **模型路由** 新建别名 `auto`。填入当前账户可用的真实模型 ID，按首选模型、轻量模型、备用渠道的顺序排列。Gemini 的模型可用性和额度以 AI Studio 中的项目为准。只想使用免费额度时，只把已确认有免费额度的模型加入路由。
4. 在 **测试** 发一条短消息，确认命中的渠道与模型。客户端使用控制台顶部的 **客户端 Key** 和 Base URL，模型填写 `auto`。

客户端接入示例。在终端用自己的客户端 Key 替换 `hub_...`。

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer hub_...' \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

- `GET /v1/models` 列出模型别名。两个 API 都需要客户端 Key。
- `POST /v1/chat/completions` 支持 JSON 和 `stream:true` 的 SSE。成功响应中的 `X-Gateway-Channel`、`X-Gateway-Model` 可查看实际命中项。
- Chat Completions 的字段会转给上游。工具、图片、结构化输出等能力取决于所选渠道和模型，建议将支持同一组能力的模型放入同一路由。当前覆盖范围是 Chat Completions 和模型列表。

## 配额与切换规则

- Gemini 以 **项目 ID + 模型** 为配额单位。来自同一项目的多把 Key 使用相同项目 ID。其他渠道可填写配额组，让同类型、同组、同模型的渠道共享额度。留空时，相同 Base URL、工作区、Key 与模型自动共用计数。
- RPM 按过去 60 秒计算。RPD 按日计算，Gemini 在美国太平洋时区午夜重置，其他渠道的本地计数按 UTC 午夜重置。多个路由共用一个配额时，采用已启用候选中最小的非零限制。0 表示跳过该项本地预限流。
- 本地计数统计经由这个网关发出的尝试，包括已发送后失败的请求。网关外的调用以服务商统计为准，TPM 等限制由上游执行。
- 额度已满时跳过该候选。遇到 429 会记录冷却，优先参考上游的 `Retry-After`。缺少提示时默认冷却 60 秒。明确识别到 Gemini 日额度用尽时，冷却到下次日额度重置。
- 余额或凭据异常、模型不可用、上游 5xx 和网络超时也可以触发切换。请求参数错误直接返回。首段有效流式内容已发出时，连接中断由客户端处理。上游超时后切换可能产生多次计量。
- 所有候选均因配额暂不可用时返回 429。因其他故障无可用候选时返回 503。能推断下次可尝试的时间时会附带 `Retry-After`。

## 本地数据

默认在项目目录 `data/state.json` 保存配置、Key 和额度计数。忘记管理 Key 时可在 Termux 中读取该文件的 `adminKey` 字段。保留一份私有备份，且把文件放在 Termux 私有目录。将一份数据目录用于一个网关进程。若要更换目录，可设置 `HUB_DATA_DIR`。配置页启用后无需重启即可更新渠道与路由。

## 验证与上游文档

`node --test` 使用本机模拟上游，覆盖鉴权、额度共享、并发、重启持久化、JSON 和 SSE 切换，无需真实 API Key。

- [Gemini 配额](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini 的 OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)
- [Anthropic 的 OpenAI 兼容接口和功能范围](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [DeepSeek 接口](https://api-docs.deepseek.com/quick_start/agent_integrations/)
- [OpenRouter 接口](https://openrouter.ai/developers)
