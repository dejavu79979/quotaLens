# QuotaLens

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文**

QuotaLens 把 Claude Code 与 Codex 的订阅用量显示在 Even Realities G2 眼镜上。一个自托管的桌面 daemon 读取本机的用量来源,通过你的 [Tailscale](https://tailscale.com/) tailnet(在你自己的设备之间建立的私有 WireGuard 网络,个人使用免费)提供百分比与重置时间,再由 Even Hub app 把它们渲染到眼镜上,用 R1 戒指或镜腿操作。

用 Claude Code 或 Codex 打开这个仓库,让它帮你安装 QuotaLens,或诊断连接问题、用量来源缺失的问题;`CLAUDE.md` 与 `AGENTS.md` 提供必要的操作手册与安全规则。

## 架构

```text
桌面 daemon ── Tailscale/WireGuard 内的 HTTP ──> Even App plugin ── BLE ──> G2 眼镜
Claude + Codex                                                 <── R1 / 镜腿输入
```

plugin 轮询 `GET /usage.json`;daemon 监听 loopback 与桌面的 Tailscale IPv4 地址,端口 8787。

## 眼镜上的画面

用量页:每个工具一段,列出 5 小时窗口与每周限额、进度条、重置时间,以及数字有多新(`ok` 或 `stale Xm`)。Claude 的第三行是套餐提供时的"单一模型每周限额"。

![G2 上的用量页:CLAUDE 与 CODEX 两段,含百分比、进度条与重置时间](docs/images/glasses-usage.png)

首次启动、尚未设置 relay address 时:

![首次启动:"Set the relay address in the Even App on your phone"](docs/images/glasses-first-launch.png)

长按打开菜单(Refresh now / Exit):

![菜单:Refresh now、Token stats · soon、Exit](docs/images/glasses-menu.png)

截图取自 Even Hub simulator,分辨率为 G2 的 576×288;眼镜上呈现同样的绿色透明布局。

## 手机上的画面

QuotaLens 在 Even App 内只有一个设置页。把桌面安装程序打印的 relay address 粘贴到 **Relay address**(接受 `100.x.y.z`、`100.x.y.z:8787` 或完整的 `http://` origin,会自动规范化),选择眼镜的轮询间隔,然后点 **Test connection** 确认手机能通过 Tailscale 连到 daemon。修改会立即保存,没有 Save 按钮。

![Even App 内的设置页:Relay address 字段、Poll interval(1–60 分钟,默认 3)、Test connection](docs/images/phone-settings.png)

这是以占位地址渲染的示意图;`✓ <ms>` 那一行只是展示测试成功时的样子,不是实测数值。

## 需求

| 项目 | 支持的环境 |
|---|---|
| 眼镜与手机 | Even Realities G2 与 Even App 2.2.10 以上 |
| 桌面操作系统 | macOS(已测试);Linux 附有未测试的 systemd user unit 模板与手动安装步骤 |
| Node.js | 20.19+、22.13+ 或 24+ |
| 本机工具 | 桌面需要 `jq`;桌面与手机都要安装 [Tailscale](https://tailscale.com/download) 并登录同一个 tailnet |
| 用量来源 | Claude Code 和/或 Codex CLI,以订阅账号登录 |

只用 Claude Code 或只用 Codex 都可以;没有的那一段不会显示。

## 安装

桌面端:

```bash
git clone https://github.com/dejavu79979/quotaLens.git quotaLens
cd quotaLens
bash scripts/install.sh
```

macOS 安装程序会检查前置条件、安装依赖、记录桌面的 tailnet IPv4、安装一个用户级的 LaunchAgent、验证 relay,并可选地接入 Claude Code 的 status line。完成时会打印类似 `http://100.x.y.z:8787` 的 relay address。运行 `bash scripts/install.sh --dry-run` 可以只查看它会做什么而不写入任何东西。

手机端:

1. 让 Tailscale 保持连接,并与桌面在同一个 tailnet。
2. 从 Even Hub 商店安装 QuotaLens。
3. 打开 QuotaLens 设置,把打印出的地址粘贴到 **Relay address**。
4. 点 **Test connection**。出现 `✓ <ms> ms` 表示 app 能连到 daemon。

完整的安装与恢复步骤见 [docs/INSTALL.md](docs/INSTALL.md)(英文)。

在地址设置好之前,眼镜会显示一段简短的设置提示,而不是黑屏。

## 用 AI coding agent 操作

这个仓库附有给 Claude Code 的 `CLAUDE.md` 与给 Codex 的 `AGENTS.md`。
两者提供安装、验证与调试的操作手册,以及安全规则。
用任一工具打开仓库,让它在这台机器上安装 QuotaLens。
也可以让它诊断眼镜卡在 `Connecting…` 或来源显示 `none` 的问题。
agent 必须遵守那些规则:凭据只能读取,绝不能粘贴到任何地方。

## 眼镜操作(R1 戒指或镜腿)

| 手势 | 用量页 | 菜单 |
|---|---|---|
| 单击(tap) | 立即刷新 | 选中 |
| 上/下滑(swipe) | 只有一页;footer 会提示 | 移动光标 |
| 长按(long-press) | 打开菜单(Refresh now / Token stats · soon / Exit) | — |
| 双击(double-tap) | 系统的退出确认 | 返回 |

## 安全边界

- OAuth token 从桌面上 Claude Code 与 Codex CLI 的凭据存储读取,只会以 HTTPS authorization header 发往 Anthropic 与 OpenAI 自己的用量端点。它们绝不会发送到手机或眼镜,绝不会出现在 relay 响应、日志或这个仓库里,QuotaLens 也绝不写入或刷新它们。
- relay 只承载 `shared/schema.ts` 定义的 `UsagePayload`:各工具的用量百分比与重置时间、获取时间戳、`ok` 标志与说明数字来源的 `source` 标签、供应商有报告时的剩余预付额度(USD)、payload 的 `generatedAt` 时间,以及每周限额所对应的 Claude 模型显示名称。没有账号标识、session 数据或凭据。
- tailnet 是唯一的认证层。tailnet 内的每台设备都能读到 relay,所以请限制 tailnet 的成员。
- 安全规则:绝不用 `tailscale funnel` 把端口 8787 对外开放。没有额外的 secret,Funnel 会让用量端点变成公开的。

## 故障排除

| 症状 | 检查 |
|---|---|
| Test connection 显示 `net err` 或 `timeout` | 确认两台设备的 Tailscale 都已连接,然后重新运行 `bash scripts/install.sh` |
| Test connection 显示 `HTTP 404` | 那个地址有东西响应,但不是 QuotaLens daemon:检查 IP,以及是否有别的服务占用端口 8787 |
| `claude.source` 或 `codex.source` 是 `none` | 确认该工具已安装并登录,然后查看 `~/Library/Logs/quotalens.log` |
| 眼镜一直显示 `Connecting…` | 在手机上测试 relay,并确认 daemon 的 tailnet 探测打印出 `200` |
| 蓝牙重新连接后 app 消失 | 用 Even App 的"发送到眼镜"功能重新打开 |

## 自行打包的备用方案

Even 的文档描述了严格的逐 origin 网络白名单,不过实测 Even App 2.2.10 对商店安装的 app 并未强制执行。若日后开始强制,请自行打包一个包含你自己 tailnet origin 的版本:

```bash
bash scripts/install.sh --self-pack
cd plugin
npm run build
npx evenhub pack app.json dist -o quotalens.ehpk --sdk-ver 0.0.15
```

到 Even Hub Developer Center 上传 `plugin/quotalens.ehpk` 并安装该版本。`--self-pack` 会有意修改 `plugin/app.json`;普通安装不会改动 checkout。

## 许可证

[MIT](LICENSE) © 2026 dejavu79979。Even Hub 商店的披露事项见[隐私政策](docs/PRIVACY.md)(英文)。
