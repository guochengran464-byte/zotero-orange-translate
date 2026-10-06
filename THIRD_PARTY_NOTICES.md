# 上游与第三方说明

Orange Translate 可复用已有本地翻译环境，或按用户选择的位置下载并安装上游组件；XPI 不内置 Python、pdf2zh-next、BabelDOC 或模型/字体资产。

| 项目 | 使用方式 | 开发时运行版本 | 上游许可证 |
| --- | --- | --- | --- |
| [PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) | 本地翻译 CLI / Python API、提示词及服务商接口 | pdf2zh-next 2.9.0 | [AGPL v3](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/main/LICENSE) |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC) | PDF 解析、翻译流程与排版 | 0.6.2 | [AGPL v3](https://github.com/funstory-ai/BabelDOC/blob/main/LICENSE) |
| [uv](https://github.com/astral-sh/uv) | 下载并管理 Python、安装翻译依赖；工具下载固定 SHA256 校验 | 0.12.23 | [MIT / Apache 2.0](https://github.com/astral-sh/uv#license) |
| [Python](https://www.python.org/) | uv 安装的 Python 3.12 运行环境 | 3.12 系列 | [PSF License](https://docs.python.org/3/license.html) |

感谢 PDFMathTranslate-next 的原作者和贡献者，以及 funstory-ai/BabelDOC 团队与贡献者。翻译和排版引擎归上游作者；Orange Translate 的工作是 Zotero 集成与运行时适配。

环境选择、联网准备及校验流程参考项目使用者提供的“PDF翻译器_微信联网便携版_可选安装位置_已验证_v2”启动包。其官方 EXE 包不能直接代入本插件的 Python 连接器，因此安装器使用上游支持的 uv 路线；保留已在插件中使用的 pdf2zh-next 2.9.0 / BabelDOC 0.6.2 组合，不复制启动包中的 API-settings.txt 或密钥。

本仓库中的上游参考源码若包含原始版权和许可证头，应继续保留。运行环境其他依赖、模型、字体及用户提供的图标素材，分别遵循其原始来源的许可条件。

在个人 GitHub 账户建立上游 Fork 时，请保持原作者、版权、LICENSE 和历史记录。本插件仓库与独立的上游 Fork 分开维护。
