# 焦点闪回排行榜

《重返未来：1999》非官方社区排行榜。[打开网站](https://huan-god.github.io/flashback-leaderboard/)

首期收录国服 4.1 第 7 期。子关卡编号与推荐队伍来自[重返未来1999中文 Wiki 的关卡一览](https://res1999.huijiwiki.com/wiki/焦点闪回)。

- Ⅰ · 洞知／额外行动
- Ⅱ · 余辉／仪式
- Ⅲ · 术具／仪式

玩家可用昵称投稿，当前浏览器会保留投稿身份。通关截图仅投稿者和授权审核员可读取。玩家可选填通关视频、攻略等相关链接，随上榜纪录公开。审核通过后，同一期、同关卡、同塑造组和完整阵容只记录一个最低回合成绩，同回合按服务器提交时间排序。

## 部署

GitHub Pages 从 `main` 根目录发布静态网页，Supabase 提供登录、榜单、审核与私有截图存储。新项目依次运行 `supabase/schema.sql`、`supabase/003_related_links.sql`、`supabase/004_challenge_rankings.sql`、`supabase/seed_4_1.sql` 以及 `supabase/005_import_v39.sql` 至 `supabase/008_include_credited_players.sql`。已有项目按编号补齐尚未应用的迁移。只有初代数据库需要先运行 `002_remove_records.sql`。

4.1 第 7 期的表格成绩以 6 回合登记到常规主榜。原表中的配队简称及替代位保留在队伍栏，每行记录第一位攻略者，已有成绩跳过。管理员可直接编辑成绩，榜单按修改后的数据重算。主榜可以筛选已有的主 C，共同主 C 各自可选。主 C 双榜可查看所选版本的本期统计或跨期历史总计。通关数按关联后的关卡去重，上榜次数按同一关卡的塑造组和配队去重。

表格中的攻略者通过站内玩家档案归集，按昵称去重后计入参与玩家和玩家荣誉。已注册玩家按站内账号归集。

将项目 URL 和 publishable key 写入 `config.js`。在 Supabase Auth 启用匿名登录和邮箱登录，将 Pages 的完整网址填写为 Site URL 并加入 Redirect URLs。审核员须使用已验证的邮箱账号，并由项目所有者授权。管理密钥不得提交至仓库。

运行排名规则测试：`node --test tests/logic.test.mjs`。
