# 账号与权限

## 登录

用户名和密码。`POST /api/auth/login`，正文为 `{ "username", "password" }`。没有自助注册。

密码只存 scrypt 哈希。生成哈希：

```bash
npm run admin-password -- '<密码>'
```

把输出写入 `config/platform.json` 的 `superadmin.passwordHash`。Docker 启动时用环境变量 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 建立同一名管理员。

## 管理员与其他账号

首次启动读取 `superadmin` 的用户名和密码哈希，建立管理员。管理员创建其他账号：`POST /api/admin/users`。

管理员可以修改被测、仿真用户和评审的配置。普通登录用户可以发起运行，并做纳入回归、驳回、无法判定。

## API Key

用户在「我的」签发 Key，交给本地 Agent：`Authorization: Bearer <Key>`。

Key 可以读取、提交人群和剧本、发起运行、重试评审。不能代替人做判定，也不能修改被测和模型配置。Key 的操作记在签发者名下。

## 配额与审计

开跑前按预估占用当日额度，跑完用实际用量回写。超过当日上限时拒绝新开局，不中断已经开始的一局。

操作人写在 MySQL 的 `audit_log`，不写进人群或剧本文件。

## 部署

单机运行：一个应用进程加 MySQL 8。配置来自 `config/platform.json` 与环境变量。步骤见 [README](../README.md)。
