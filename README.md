# Orange Translate

Zotero PDF 翻译插件。选择文献或 PDF 后，调用本地 **PDFMathTranslate-next / BabelDOC** 翻译环境，生成中英对照和纯中文 PDF，保存到原文旁边，并添加为原文献的附件。

**[下载 Orange Translate 1.2.0](https://github.com/guochengran464-byte/zotero-orange-translate/releases/download/v1.2.0/orange-translate-1.2.0.xpi)** · Zotero 10.x · Apple Silicon Mac（arm64）和 Windows x64。发布说明和 SHA-256 校验文件见 [v1.2.0 Release](https://github.com/guochengran464-byte/zotero-orange-translate/releases/tag/v1.2.0)。

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
- 首次使用可选择安装位置，一键下载并准备翻译环境；也可选择已有环境。
- 中英对照与纯中文 PDF 都保存到原 PDF 的文件夹，自动编号避免覆盖。
- 完成后通过 Zotero 原生 API 添加两个附件，保留原始 PDF。

## 当前支持范围

**1.2.0** 面向 **Windows x64** 和 **Apple Silicon Mac（arm64）**，插件包允许 Zotero 10.x 安装。Mac 端已在 Zotero 10.0.9 实测环境安装、取消后重试、双 PDF 输出和附件回挂。Windows 的实机验证记录来自 [1.1.0](https://github.com/guochengran464-byte/zotero-orange-translate/releases/tag/v1.1.0)。

每次处理一个本地英文 PDF，输出中文译文。父文献有多个 PDF 时，请直接选中目标 PDF 附件。

XPI 不内置 Python、引擎、字体和版面模型；首次点击安装后按所选位置联网下载。自动安装采用上游支持的 [uv 路线](https://pdf2zh-next.com/getting-started/INSTALLATION_uv.html)，固定 pdf2zh-next 2.9.0 / BabelDOC 0.6.2，使用受管理的 Python 3.12。安装无需 API Key，也不会读取或上传文献。

## 安装与配置

1. 下载对应版本的 `orange-translate-<version>.xpi`。
2. Zotero → **工具 → 插件**，点击插件管理器右上角的齿轮，选择 **Install Plugin From File…**，打开 XPI。在插件管理器里确认 Orange Translate 已启用。
3. Zotero 设置 → Orange Translate → **安装翻译环境（选择安装位置）**，选择一个有写入权限的文件夹，建议预留 3 GB。插件在其中创建 `OrangeTranslateRuntime`，所有下载、运行环境、任务和缓存默认放在这里。保持设置窗口打开，直到显示安装完成。
4. 已有匹配便携环境时，点击 **选择已有环境**，选择包含 `runtime` 的根目录，无需再次下载。
5. 填写 Base URL、协议、API Key 和模型，点击 **保存并设为当前**。需要调整线程数时，填写 **翻译线程数**，点击 **保存线程数**。
6. 右键文献或 PDF → Orange Translate → 翻译 PDF。

安装过程显示下载工具、Python、引擎及字体/模型等阶段，可点击 **取消安装**。遇到字体或模型下载超时时，在相同位置重试即可复用已下载的文件；错误详情见环境目录的 `installer.log`。保持设置窗口打开，直到显示安装完成。

### 译文保存位置

例如原文是 `D:\论文\paper.pdf`，译文为同目录下的 `paper.zh.dual.pdf`（中英对照）和 `paper.zh.mono.pdf`（纯中文）。再次翻译时自动使用 `paper.zh-2.dual.pdf` / `paper.zh-2.mono.pdf`，保留已有文件。

这里的“原文位置”是 Zotero 中该 PDF 的实际文件位置：已导入 Zotero 管理的原文对应其 `storage` 文件夹；链接附件对应用户原有文件夹。原文目录需要可写。

个人文献库通过 Zotero 链接附件指向这两份文件；组文献库使用 Zotero 管理的附件导入，同时保留同目录译文。个人库的链接文件不通过 Zotero 文件同步上传，跨设备使用需要自行同步所在文件夹。

### 本地翻译环境路径

选择已有环境时，打开包含 `runtime` 的根目录。Python 在 macOS 上位于 `runtime/python/bin/python`，在 Windows 上位于 `runtime/python/Scripts/python.exe` 或 `runtime/python/python.exe`。两端的引擎都位于 `runtime/libs/`，自动下载的模型和字体位于 `.cache/babeldoc/`。

高级用户还可通过 Zotero 设置 → 高级 → 设置编辑器配置：

| 偏好 | 用途 |
| --- | --- |
| `extensions.orange-translate.runtimeRoot` | 便携翻译环境根目录 |
| `extensions.orange-translate.jobsRoot` | 可选任务及缓存目录，留空使用所选环境内的 `jobs/` |

默认不包含开发者本机路径。普通 Python/uv 环境不能直接代入已有便携环境入口，应使用插件自动安装。

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

产物为 `dist/orange-translate-1.2.0.xpi`。在 Zotero 的插件管理器里选择该文件安装。

## 许可证

插件代码采用 **GNU AGPL v3**，见 [LICENSE](LICENSE)。上游代码、运行环境与第三方资源保留各自许可证和作者信息。插件图标为项目使用者提供的素材，本仓库不授予其原始角色或美术作品的额外权利。
