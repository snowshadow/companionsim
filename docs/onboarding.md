# 第一次在本地跑通

前置、Docker 与本地命令见 [README](../README.md)。本文只写服务起来之后的几步。

1. 打开 <http://localhost:5260>，用 `config/platform.json` 里 `superadmin` 的用户名和密码登录。
2. 被测选进程内样例 `fixture`。这一步用来确认数据库和界面，不需要外部模型。
3. 要让仿真用户和评审调用模型，按 README 配好两条连接和 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`，然后重启进程。
4. 在探索页选择人群、剧本和被测，发起一局。对话结束后自动评审。
5. 在待审里选择纳入回归、驳回或无法判定。纳入回归之后，回归页用冻结台词重跑。

没有自助注册。其他账号由管理员在管理页创建，或调用 `POST /api/admin/users`。

人群和剧本的写法见 [agent-spec.md](agent-spec.md)。登记被测与发起运行见 Skill [companionsim-ops](../.cursor/skills/companionsim-ops/SKILL.md)；编写人群和剧本见 [companionsim-author](../.cursor/skills/companionsim-author/SKILL.md)。
