# 贡献

本仓库以 [Apache-2.0](LICENSE) 授权。提交到本仓库的贡献也按该许可证提供。

## 本地测试

前置与 [README](README.md) 相同：Node.js ≥ 20。完整的权限与配额用例需要 MySQL 8。

```bash
npm ci
npm test
npm run build
```

依赖数据库的用例读取这些环境变量（也可写在 `.env.local`，不要提交）：

- `SIM_EVAL_TEST_MYSQL_HOST`
- `SIM_EVAL_TEST_MYSQL_PORT`
- `SIM_EVAL_TEST_MYSQL_USER`
- `SIM_EVAL_TEST_MYSQL_PASSWORD`

未设置时，这些用例会跳过。GitHub Actions 会挂一个公网 `mysql:8` 并设置上述变量，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## Pull Request

- 说明改了什么、如何验证。
- `npm test` 与 `npm run build` 通过。涉及界面时，写明你实际点过的路径。
- 不要提交 `.env.local`、`config/platform.json`、密钥或会话 cookie。见 [SECURITY.md](SECURITY.md)。
- 保持改动范围与问题一致。架构现状以 [docs/architecture.md](docs/architecture.md) 为准。
