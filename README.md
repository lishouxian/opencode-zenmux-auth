# opencode-zenmux-auth

A ZenMux provider plugin for OpenCode and [magpie](https://usemagpie.ai).
Its model catalog comes from ZenMux's own
[`@zenmux/opencode-oauth`](https://github.com/ZenMux/opencode-plugin) (MIT);
what it adds is the subscription's **5-hour and 7-day usage** on magpie's
Usage page. It signs in with an API key only, no OAuth.

- Sign in with a ZenMux API key; the Management API key next to it is optional.
- Models come from ZenMux's catalog, each on its own protocol (Anthropic
  Messages, OpenAI Responses or Chat Completions).
- Usage: ZenMux tells a subscription's windows only to a **Management API
  key** (`sk-mg-v1-…`, created at <https://zenmux.ai/platform/management>),
  not to an API key. Sign-in asks for one after the API key (leave it empty
  to skip); it is kept with the account and used only for
  `GET /api/v1/management/subscription/detail`. The monthly cap isn't shown:
  ZenMux tells no use against it.

## Install in magpie

```sh
magpie plugin add ./opencode-zenmux-auth          # this folder
magpie plugin add github:<you>/opencode-zenmux-auth
```

Then add a ZenMux account from the Plugins page: the API key, and the
Management API key if you want the usage card. To add one later, add the
account again.

## 中文说明

模型目录来自 ZenMux 官方的 `@zenmux/opencode-oauth`（MIT），只用 API Key 登录，不支持 OAuth；额外在 magpie 用量页显示订阅套餐的
5 小时和 7 天额度。额度只能用 Management API Key（`sk-mg-v1-…`，在
zenmux.ai/platform/management 创建）查询，登录时选填；之后想补填，需要重新添加账号。月度上限没有已用量，不显示。

## Test

```sh
node --test
```
