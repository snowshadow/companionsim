# 安全

## 报告漏洞

请使用 GitHub Security Advisories 私下报告（仓库的 Security → Advisories）。

若暂时无法使用 Advisories，通过 GitHub Issues 私下联系维护者，并避免在公开讨论里贴出利用细节、密钥或会话内容。

## 不要提交

- `.env.local` 以及任何填了真实值的环境文件
- `config/platform.json`（数据库口令、管理员密码哈希）
- API 密钥、模型密钥、被测服务的凭据
- 会话 cookie，以及浏览器里导出的登录态

模板可以提交：[`config/platform.example.json`](config/platform.example.json)、[`.env.example`](.env.example)。其中不要填入真实密钥。
