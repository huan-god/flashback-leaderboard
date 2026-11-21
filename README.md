# 焦点闪回 · 玩家排行榜

《重返未来：1999》非官方玩家社区成绩站原型，适合用 **GitHub Pages + Supabase** 部署。

## 已完成功能

- 每个游戏版本恰好 3 个关卡；分全 0 塑造和全满塑造两组。
- 投稿昵称、主 C、实际上场完整队伍、0—6 回合及通关截图。
- 唯一纪录规则：同关卡 + 同塑造 + 同完整阵容仅显示**最低回合**纪录，同回合**服务器提交时间更早**者获胜，审核顺序不影响结果。
- 玩家荣誉榜：历史持榜次数按「版本/关卡/组别/阵容/玩家」去重；当前持榜数实时计算。
- 管理后台：三个分组（待审核 / 已通过 / 已移除）、查看私有截图、审核通过或拒绝、撤销已通过成绩并记录原因、新建版本。
- 生产模式：邮箱免密码登录、账号关联成绩、私有截图存储、RLS 权限隔离。
- 本地演示模式：无需任何后端，可交互、可投稿、审核和撤销成绩，测试结果保留在**当前浏览器**；演示后台没有真实身份鉴权。

## 先试一下：不配置也能打开

直接双击 `index.html` 可看演示页面。如遇浏览器阻止本地 ES 模块加载，请在项目目录执行：

```bash
python -m http.server 8000
```

打开 <http://localhost:8000>。推荐使用此方式。

**测试流程**：先看首页「排行榜」→ 点击「投稿成绩」→ 上传一张测试截图 → 点击右上角「演示审核后台」→「查看截图」并「审核通过」→ 进入「已通过」切页，点「移除这条成绩」填写原因 → 返回排行榜确认重排。可以在后台新建一个版本。演示人物和成绩都是虚构测试数据。

演示模式用 `localStorage` 保存数据：不同用户/设备**不会共享**！不要把它误认为真正运行的多人投稿网站。清空该站浏览器本地存储后会恢复初始演示数据。

## 上线真实多人网站：四步

### 1. 创建 Supabase 项目

在 [Supabase](https://supabase.com) 创建项目。打开项目的 **SQL Editor**，将 `supabase/schema.sql` 全文执行一次。该脚本创建表、视图、审核函数、Storage 桶和 Row Level Security 策略。它面向全新项目；**请勿在已保存重要数据的数据库中盲目重复执行**。

打开 **Authentication → Providers**，开启 Email 邮箱登录；在 **Authentication → URL Configuration** 添加真实站点 URL 到 `Redirect URLs`。使用 GitHub Pages 项目网址时，例如：

`https://你的GitHub用户名.github.io/flashback-leaderboard/`

注意邮件供应商限额，访问量增大后应配置正式 SMTP 和反滥用机制。

### 2. 配置前端

修改根目录 `config.js`：

```js
window.FLASHBACK_CONFIG = {
  supabaseUrl: 'https://你的项目标识.supabase.co',
  supabaseAnonKey: '你的 Supabase Publishable key 或旧 anon key'
};
```

在 Supabase 项目 **Settings / API Keys** 找到 Publishable key 或旧版 anon 公钥。**绝不能将 `service_role`、`sb_secret_...` 等密钥放入 `config.js` 或 GitHub 公开仓库。**前端公开的 publishable / anon key 必须依赖 SQL 脚本里的 RLS 安全规则。

### 3. 指定管理员

首先在真实网站点击「玩家登录」，用你自己的邮箱登录，并设置玩家昵称。登录后，在 Supabase SQL Editor 运行（替换下面邮箱）：

```sql
insert into public.admins (user_id)
select id from auth.users where email = '你的邮箱@example.com'
on conflict (user_id) do nothing;
```

**必须确认成功插入一行**，否则说明该邮箱还未登录注册。刷新网站即可看到「管理后台」。普通注册用户只有自己投稿和查看公开排行榜的权限，不能审核或移除成绩。随后在后台新建真实游戏版本和三个关卡。建议正式运营前不要保留测试版和虚构纪录。

### 4. 部署到 GitHub Pages

在 GitHub 创建一个新仓库（例如 `flashback-leaderboard`），上传根目录所有文件和 `supabase/schema.sql`。确认 `index.html` 位于仓库根目录。打开：

**Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main → Folder: /(root) → Save**

稍后 GitHub Pages 会提供网站 URL：

`https://你的GitHub用户名.github.io/flashback-leaderboard/`

把**确切的上线 URL**加入 Supabase Authentication 的 Redirect URLs，并视需要修改 Site URL。上传后的网页代码公开，截图存储桶依旧是私有的。

> `config.js` 不填 URL/Key 就会使用单浏览器演示模式。如果上传到 GitHub 后还是看到「本地演示」，说明 Supabase 尚未连接成功。

## 规则实现说明

- 同队判定：角色名 NFKC 规范化、修剪首尾空格、大小写折叠，再排序拼接；因此队伍先后顺序不影响同队判定。主 C 必须属于该队伍，但不改变唯一队伍身份。
- `submissions.created_at` 由数据库插入触发器强制写入，不能被客户端冒充；时间完全相同则用 UUID 做稳定决胜依据。
- 投稿必须审核通过才参与榜单。服务端审核 RPC 在事务内对同组队伍加锁，比较审核前后赢家并原子记载历史取得纪录事件。
- 同一玩家反复夺回完全相同的「关卡/组别/阵容」，历史荣誉最多计一次。同一阵容不同关卡或版本分别计数。
- 管理后台支持撤销已经通过的成绩：填写撤销原因，服务端将状态改为 `removed`，保留截图、审核原因、操作者与时间；公开榜单自动回退到其他有效成绩，历史荣誉只统计有效 `approved` 投稿。
- 数据库另有 `moderation_actions` 审核日志表，RLS 只允许管理员读取。
- 需要截图审核才能确认塑造组是否填写正确。目前依靠人工判定，不做自动识别。

## 当前原型的边界与待办

- **角色是自由输入文本**，未内置完整的游戏角色资料和头像。后续建议维护标准角色 ID 表及头像选择器，避免同一角色的简称/别名拆榜。
- **全0 / 全满的定义需要管理员正式公布**（例如角色个数、灵感、支援位等），目前数据库只保存玩家选择的分组。
- **默认不收录玩家 UID**，昵称绑定网站邮箱账号；为了防止冒名注册，正式运营时应制定玩家实名认证/改名规则。
- 反刷稿、图片内容审核、垃圾数据清理、邮件发送额度与隐私告知，正式公开推广前还需完善。审核日志已提供基本实现。
- 目前仅有一个成绩截图字段，管理员可以通过生成短期签名 URL 查看图片，普通访客无法读取截图。
- GitHub Pages 只能托管静态网站；Supabase 承担数据库、登录及文件上传服务。

## 开发与测试

不需要编译器或包管理器。前端仅由 `index.html`、`styles.css`、`app.js`、`logic.mjs`、`config.js` 组成。

运行排序逻辑单元测试：

```bash
node --test tests/logic.test.mjs
```

如果修改 SQL，请务必在新的 Supabase 测试项目中运行并验证 RLS 行为，不要把匿名 key 当成授权证明。

---

## 已有 V1 项目的安全升级

如果之前已经在 Supabase 执行过 V1 `schema.sql`，**不要**重跑整个新版初始化脚本。请先备份数据库，再在 SQL Editor 运行：

`supabase/002_remove_records.sql`

它新增 `removed` 状态、管理员移除函数、撤销审计表，同时将旧审核函数限制为只能审核待审投稿。前端同时替换新版文件。此脚本与新版 `schema.sql` 二选一：全新数据库使用新版 `schema.sql` 即可。

## Wiki 参考和信息边界

- 参照 [重返未来1999中文 Wiki · 焦点闪回](https://res1999.huijiwiki.com/wiki/%E7%84%A6%E7%82%B9%E9%97%AA%E5%9B%9E)。Wiki 记载焦点闪回为自 3.6 版本起的周期挑战玩法，可按期次查看子关卡和机制。
- 网站已在「排行榜规则」页加入 Wiki 入口。排行榜的每版本三关、全0 / 全满分组、0—6 回合和唯一成绩机制是站点自设规则。为避免误导，演示中的关卡与角色名称不充当实际游戏资料。
- 未来可以将「管理后台」授权给其他审核人员：管理员账号映射到 `public.admins` 表，每添加一个授权账号就可共享同一套审核与撤销权限。**目前不提供在线添加管理员的界面**，只有 Supabase 项目所有者可在 SQL Editor 中授权；请仅授权可信用户。示例（将邮箱换成已注册账号）：

```sql
insert into public.admins (user_id)
select id from auth.users where email = '审核员邮箱@example.com'
on conflict (user_id) do nothing;
```

- **区分玩家登录与审核权限**：当前为确保排行榜玩家身份稳定，真实投稿玩家仍需要邮箱登录。管理员通过相同邮箱登录方式认证，但只有你在 `admins` 表授权的账号能管理审核。演示模式没有真实鉴权，切勿当作上线权限保护。

---

非官方玩家项目。视觉素材使用 CSS 绘制的原创抽象图案，未使用游戏角色图像或游戏公司徽标。
