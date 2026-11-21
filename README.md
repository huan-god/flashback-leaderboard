# 焦点闪回排行榜

《重返未来：1999》非官方社区排行榜。[打开网站](https://huan-god.github.io/flashback-leaderboard/)

首期收录国服 4.1 第 7 期。子关卡编号与推荐队伍来自[重返未来1999中文 Wiki 的关卡一览](https://res1999.huijiwiki.com/wiki/焦点闪回)。

- Ⅰ · 洞知／额外行动
- Ⅱ · 余辉／仪式
- Ⅲ · 术具／仪式

玩家可用昵称投稿，当前浏览器会保留投稿身份。通关截图仅投稿者和授权审核员可读取。玩家可选填通关视频、攻略等相关链接，随上榜纪录公开。审核通过后，同一期、同关卡、同塑造组和完整阵容只记录一个最低回合成绩，同回合按服务器提交时间排序。

## 部署

GitHub Pages 从 `main` 根目录发布静态网页，Supabase 提供登录、榜单、审核与私有截图存储。新项目依次运行 `supabase/schema.sql`、`supabase/003_related_links.sql` 和 `supabase/seed_4_1.sql`。已有 V1 数据库先备份，再依次应用 `002_remove_records.sql` 和 `003_related_links.sql`。已有 V2 数据库只需应用 `003_related_links.sql`。

将项目 URL 和 publishable key 写入 `config.js`。在 Supabase Auth 启用匿名登录和邮箱登录，将 Pages 的完整网址填写为 Site URL 并加入 Redirect URLs。审核员须使用已验证的邮箱账号，并由项目所有者授权。管理密钥不得提交至仓库。

运行排名规则测试：`node --test tests/logic.test.mjs`。
