# 上游与第三方说明

Orange Translate 复用已有本地翻译环境，不在 XPI 中分发 Python、pdf2zh-next、BabelDOC 或模型/字体资产。

| 项目 | 使用方式 | 开发时运行版本 | 上游许可证 |
| --- | --- | --- | --- |
| [PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) | 本地翻译 CLI / Python API、提示词及服务商接口 | pdf2zh-next 2.9.0 | [AGPL v3](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/main/LICENSE) |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC) | PDF 解析、翻译流程与排版 | 0.6.2 | [AGPL v3](https://github.com/funstory-ai/BabelDOC/blob/main/LICENSE) |

感谢 PDFMathTranslate-next 的原作者和贡献者，以及 funstory-ai/BabelDOC 团队与贡献者。翻译和排版引擎归上游作者；Orange Translate 的工作是 Zotero 集成与运行时适配。

本仓库中的上游参考源码若包含原始版权和许可证头，应继续保留。运行环境其他依赖、模型、字体及用户提供的图标素材，分别遵循其原始来源的许可条件。

在个人 GitHub 账户建立上游 Fork 时，请保持原作者、版权、LICENSE 和历史记录。本插件仓库与独立的上游 Fork 分开维护。
