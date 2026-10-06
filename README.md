# Orange Translate

Zotero PDF 翻译插件。选择文献或 PDF 后，调用本地 **PDFMathTranslate-next / BabelDOC** 翻译环境，生成双语 PDF，并自动添加为原文献的附件。

**[下载 0.3.5 安装包](https://github.com/guochengran464-byte/zotero-orange-translate/raw/refs/heads/main/releases/0.3.5/orange-translate-0.3.5.xpi)** · Windows x64 / Zotero 10.x

## 上游项目与原作者

本项目的 PDF 翻译与排版能力来自：

- **[PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next)**：`pdf2zh-next` 翻译程序及服务商调用接口。感谢原作者与所有贡献者。
- **[BabelDOC](https://github.com/funstory-ai/BabelDOC)**：由 funstory-ai 团队及贡献者维护的 PDF 翻译与排版引擎。

Orange Translate 提供 Zotero 菜单、选中文献解析、本地进程连接、API/模型设置、进度展示及译文附件回挂。上游翻译与排版成果归原作者；本项目与上游团队无官方隶属关系。

插件作为独立集成项目维护，上游 Fork 单独保留。详细来源及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本账户的上游 Fork：[guochengran464-byte/PDFMathTranslate-next](https://github.com/guochengran464-byte/PDFMathTranslate-next)，Fork 自上述原作者仓库。

## 当前功能

- 文献右键 **Orange Translate** 子菜单：翻译 PDF、取消翻译、API 与模型设置。
- 使用自备 API Key，支持 OpenAI **Responses** 与 **Chat Completions** 兼容接口。
- 多个服务商配置；模型列表拉取或手动填写；短请求连接测试。
- 显示引擎整体百分比、当前阶段、处理数量及 API 请求计数。
- 每个线程池默认 16，可在设置中调整为 1–64；下一次任务生效。
- 完成后通过 Zotero 原生 API 添加双语附件，保留原始 PDF。

## 当前支持范围

当前版本 **0.3.5**。真实使用确认来自 **Windows x64 / Zotero 10.0.3**。插件包目前允许 Zotero 10.x 安装；其他 10.x 小版本仍需实际验证。Zotero 7/8/9 支持尚未交付。

每次处理一个本地英文 PDF，输出中文译文。父文献有多个 PDF 时，请直接选中目标 PDF 附件。

**此版需要已有的本地便携翻译环境，不包含 Python、翻译引擎、字体或版面模型，也未实现自动安装运行环境。**开发时使用 Python 3.12.13、pdf2zh-next 2.9.0、BabelDOC 0.6.2。

## 安装与配置

1. 下载对应版本的 `orange-translate-<version>.xpi`。
2. Zotero → 工具 → 插件 → 从文件安装插件，选择 XPI，然后完全退出并重启 Zotero。
3. 在 Zotero 设置 → Orange Translate 中填写 Base URL、协议、API Key 和模型，点击 **保存并设为当前**。
4. 需要调整线程数时，填写 **翻译线程数**，点击 **保存线程数**。
5. 右键文献或 PDF → Orange Translate → 翻译 PDF。

### 本地翻译环境路径

当前连接器使用便携环境的目录结构：

```text
<runtimeRoot>/
  runtime/python/python.exe
  runtime/libs/pdf2zh_next/
  runtime/libs/babeldoc/
  models/babeldoc/
```

通过 Zotero 设置 → 高级 → 设置编辑器配置：

| 偏好 | 用途 |
| --- | --- |
| `extensions.orange-translate.runtimeRoot` | 便携翻译环境根目录 |
| `extensions.orange-translate.jobsRoot` | 可写的任务及缓存目录 |

目前默认路径是开发者本机路径，其他电脑需改为实际目录。普通 Python/uv 安装不能直接代入上述便携目录结构。

### API 与进度

可粘贴 Base URL 或完整 `/responses`、`/chat/completions` 地址。服务商不支持 `/models` 时直接手填模型 ID。API Key 保存于 Zotero 内置密码管理器；普通偏好不保存 Key。

远程服务商会接收待翻译文本及认证请求，使用其服务可能产生费用。本地运行并不表示离线翻译。

整体百分比覆盖解析、翻译与排版阶段，与已翻译段落占比不同。线程设置是每个线程池的容量；引擎可使用多个池，不能把它视为全局 HTTP 并发上限。请求启动速率目前为每秒 4 次。允许设置 1–64 不代表服务商支持同等并发。

## 源码构建

需要 Node.js 24 或更新版本。

```sh
npm ci
npm run typecheck
npm run build
npm run check
```

产物：`dist/orange-translate-0.3.5.xpi`。构建工具不需要安装到 Zotero；运行翻译时使用本地便携环境。

## 许可证

插件代码采用 **GNU AGPL v3**，见 [LICENSE](LICENSE)。上游代码、运行环境与第三方资源保留各自许可证和作者信息。插件图标为项目使用者提供的素材，本仓库不授予其原始角色或美术作品的额外权利。
