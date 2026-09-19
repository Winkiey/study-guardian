# 部署到云服务器（用 IP 访问，免备案）

> **目标**：租一台国内轻量应用服务器，把这个平台变成一个**随时输网址就能打开的网站**，
> 不再依赖你自己的电脑开着。
>
> 全程约 20 分钟。**不需要备案** —— 备案只针对域名，直接用 IP 地址访问不涉及。

---

## 第 0 步：买服务器

### ⚠️ 先别买错产品

云厂商的服务器分好几种，**买错要么贵好几倍，要么根本跑不了**：

| 产品名 | 买不买 | 原因 |
| --- | --- | --- |
| **轻量应用服务器** | ✅ **就买这个** | 便宜、简单、够用 |
| 云服务器（CVM / ECS） | ❌ | 同配置贵好几倍，多出来的功能你用不上 |
| 虚拟主机 / 云虚拟主机 | ❌ | 只能放 PHP 网站，**跑不了 Node** |
| 对象存储（OSS / COS） | ❌ | 那只是存文件的地方，不能运行程序 |

> 关键词：**轻量应用服务器**（英文 Lightweight Application Server，缩写 LHS）。
> 腾讯云、阿里云都有这个产品，页面顶部搜索框直接搜"轻量"就能找到。

### 配置怎么选

| 项目 | 选什么 | 说明 |
| --- | --- | --- |
| **地域** | **国内**（北京 / 上海 / 广州） | 在大连的话选**北京**最近。选国内才快，且用 IP 访问免备案 |
| **机型** | **2 核 2G** 起 | 1G 在 PPT 转换时容易被系统杀掉 |
| **系统盘** | 默认（一般 40–60G） | 够用，课件加缓存也就几百兆 |
| **带宽** | 3 Mbps 起 | 个人用足够 |
| **月流量** | 200 GB 起 | 看课件会耗流量，200G 很充裕 |
| **镜像** | **系统镜像 → Ubuntu 22.04 或 24.04** | ⚠️ 见下方说明 |
| **时长** | 买 1 年 | 促销一般按年算最划算 |

### ⚠️ 镜像这步最容易选错

购买页会让你选"镜像"，默认很可能停在**应用镜像**那一栏（WordPress、宝塔面板、LNMP 之类）。

**一定要切到「系统镜像」→ 选 Ubuntu 22.04 或 24.04。**

选错不是没救（控制台里可以重装系统），但会白白折腾一次。
之所以强调 Ubuntu：本指南的命令都是按 Ubuntu 写的。

### 学生优惠怎么弄

两家都有学生认证，价格比正常便宜不少，需要学信网或学生证验证，一般几分钟到一天：

- **腾讯云**：[学生认证后购买校园套餐](https://cloud.tencent.com.cn/developer/article/2551095)
- **阿里云**：[学生身份验证入口](https://help.aliyun.com/zh/account/student-identity-verification)

> 不想折腾认证也行，正常价买最低配一年通常也就一百多块。
> 具体价格以你下单时页面显示的为准，我这里不写死数字（促销一直在变）。

### 买完立刻做三件事

1. **记下公网 IP** —— 控制台首页的实例列表里就有，形如 `123.45.67.89`
2. **重置 root 密码** —— 轻量服务器第一次买完你不知道密码，
   在实例详情里找「重置密码」或「更多 → 重置密码」，设一个你能记住的
3. **放行端口** —— 见下一节，**这步漏了后面一定打不开**

---

## 需要准备什么

- 一台**轻量应用服务器**：Ubuntu 22.04 或 24.04，**内存 2G 起**
  - 为什么至少 2G：PPT 转 PDF 走 LibreOffice，转大课件时内存会冲高，1G 容易在转换时被系统杀掉
- 服务器的**公网 IP** 和 **root 密码**

---

## 第 1 步：放行端口（最容易漏的一步）

云服务器默认只开 22 端口。放行入口在**轻量应用服务器的控制台里，叫做「防火墙」**
（注意：云服务器 CVM/ECS 里叫「安全组」，轻量里叫「防火墙」，别找错地方）：

> 控制台 → 轻量应用服务器 → 点进你的实例 → **「防火墙」页签** → 添加规则

添加两条**入站**规则：

| 应用类型 | 端口 | 协议 | 说明 |
| --- | --- | --- | --- |
| （自定义） | 22 | TCP | SSH 登录（通常已经默认有） |
| （自定义） | **3081** | TCP | 打开这个平台 |

> ⚠️ 这一步漏了，浏览器会一直转圈直到超时。很多人会误以为是程序没跑起来，
> 然后在服务器上反复折腾 —— 其实程序好得很，是外面进不来。
>
> 判断方法：在服务器上执行 `curl -I http://127.0.0.1:3081/login` 有响应，
> 但外面打不开 —— 那就是防火墙没放行。

---

## 第 2 步：登录服务器

在你**自己的电脑**上打开 PowerShell（按 Win 键 → 输入 `powershell` → 回车）：

```powershell
ssh root@你的公网IP
```

第一次连接会问 `Are you sure you want to continue connecting?`，输入 `yes` 回车，然后输密码。

> 输密码时屏幕上**不会显示任何字符**（连星号都没有），这是正常的，输完直接回车。

---

## 第 3 步：装 Node.js 和相关组件

登录成功后，在服务器上依次执行：

```bash
# Node.js 22.5 或更高（本平台用了 Node 内置的 node:sqlite，版本必须够）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# 让 PPT 预览和原件一致（不装也能用，只是预览会退化成网页版）
# ⚠️ 中文字体必须一起装，否则转出来的 PPT 里中文全是方框 —— 见下面的说明
sudo apt install -y libreoffice-impress libreoffice-writer libreoffice-calc
sudo apt install -y fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei

# 让服务常驻后台、开机自动启动
sudo npm install -g pm2
```

> ### ⚠️ 中文字体那一步别省（这是一路踩过来的）
>
> PPT 转 PDF 是**用服务器上装了的字体来画字的**。云服务器的精简镜像里几乎
> 不带任何中文字体，于是转出来的 PDF 里中文会变成**方框或乱码** ——
> 而转换本身「成功」、不报任何错，**只有你打开课件用眼睛看才能发现**。
>
> 这个坑在 Windows / macOS 上永远遇不到（系统自带中文字体），所以本地
> 测得好好的，一到服务器就出问题。
>
> **怎么确认装没装**：跑一次自检，它会直接告诉你：
>
> ```bash
> node scripts/diagnose-preview.mjs
> ```
>
> 「中文字体」那一节会给出结论，缺了还会把命令打出来。
> 设置页的「文件预览能力」那一栏也会在缺字体时提醒（标签上写「缺中文字体」）。
>
> 想要宋体更像原件，可以再补一个（可选）：
> `sudo apt install -y fonts-noto-cjk-extra`
>
> **装完不用重启服务** —— 字体是转换时现读的。
> 但**已经转好的那些 PDF 要重转一遍**，因为里面画的是方框，不会自己变好：
>
> ```bash
> node scripts/diagnose-preview.mjs --reconvert-all
> ```

---

## 第 4 步：把代码拉下来

```bash
cd /opt
git clone https://github.com/Winkiey/study-guardian.git
cd study-guardian
```

**如果仓库是私有的**，`git clone` 会要账号密码。两个办法：

1. 去 GitHub 把仓库改成 **Public** —— 代码里不含任何隐私数据，
   你的课表、成绩、推送密钥全在 `data/` 里，而 `data/` 已经被 `.gitignore` 排除了
2. 或者用 GitHub 的 **Personal Access Token** 当密码

---

## 第 5 步：配置环境变量（重要，别跳过）

```bash
cp .env.example .env
nano .env
```

确认里面有这三行（`Ctrl+O` 回车保存，`Ctrl+X` 退出）：

```
HOST=0.0.0.0
TZ=Asia/Shanghai
INVITE_CODE=换成你自己的邀请码
```

- **`HOST=0.0.0.0`** —— 不写的话只监听本机，外面根本打不开
- **`TZ=Asia/Shanghai`** —— 云服务器默认时区**常常是 UTC**。
  不写的话所有提醒会**迟发 8 小时，而且不报任何错**，只有到点了收不到推送才会发现
- **`INVITE_CODE`** —— 别人注册账号时要填的邀请码。见下面一节

### 邀请码：谁能注册，由你说了算

这个平台是多用户的：**每个人注册一个账号，数据互相看不见**。
但服务器是按流量计费的，端口又开在公网上 ——
注册口子敞着，等于把账单和磁盘交给路过的扫描器。

所以规则是：

| `INVITE_CODE` | 效果 |
| --- | --- |
| **填了**（推荐） | 别人注册时必须填对这个码才能建号 |
| **留空** | **关闭注册**。网站上的「注册」那一栏会说「暂未开放」，只有已经登录的人能用 |

> 忘了设也不会出大事 —— 默认是**关着**的，比默认敞开安全得多。
> 无论哪种情况，**站点上的第一个账号（也就是你自己）永远不用邀请码**，
> 否则管理员自己都进不去。

邀请码就是一串普通文字，自己取个好记又不容易猜的：

```bash
# 懒得想就用这条生成一个随机的（8 位十六进制）
node -e "console.log('INVITE_CODE=' + require('crypto').randomBytes(4).toString('hex'))"
```

把它填进 `.env`，然后重启：

```bash
sed -i 's/^INVITE_CODE=.*/INVITE_CODE=你的邀请码/' .env
pm2 restart study-guardian
```

之后把邀请码发给同学，他们就能自己注册了。
**随时想关掉注册，把 `.env` 里那行清空再重启即可**（已经注册的人不受影响）。

### 不开注册，但想给某个人开个号

```bash
cd /opt/study-guardian
node scripts/create-user.mjs 用户名 密码          # 建号
node scripts/create-user.mjs --list               # 看看现在有哪些账号
node scripts/reset-password.mjs 新密码 用户名      # 谁忘了密码
```

> `reset-password` 在站点有多个账号时**必须点名用户名**，
> 不点名会直接拒绝并列出所有账号 —— 免得本来想帮人重置，结果改错了人。

---

## 第 6 步：启动

```bash
pm2 start server.js --name study-guardian
pm2 save
pm2 startup
```

`pm2 startup` 会打印一行 `sudo env PATH=... pm2 startup systemd -u root ...`，
**把它整行复制粘贴执行一次**，服务就会开机自动启动。

看到这样的输出就成功了：

```
  访问地址   http://0.0.0.0:3081
  数据目录   /opt/study-guardian/data
  提醒调度   每 60 秒检查一次
```

---

## 第 7 步：打开看看

浏览器输入：

```
http://你的公网IP:3081
```

会引导你创建账号。

> **如果想把电脑上现有的数据搬过来，先别急着创建账号** —— 看下一节。

---

## 把电脑上现有的数据搬过来

这样课程、作业、Bark 推送配置就都是现成的，不用重新弄一遍。

### ⚠️ 先说一个坑

**不要直接复制 `data/app.db`。**

这个项目用 SQLite 的 WAL 模式，写入中的数据先落在 `app.db-wal` 里。
只拷 `app.db` 会得到一个**几乎空的库** —— 我之前在这个项目上就踩过：
`app.db` 只有 4KB，而真正的内容在 816KB 的 `app.db-wal` 里。

正确做法是用 SQLite 自己的 `VACUUM INTO` 打一个干净快照。它是安全的，
**即使本地服务正在运行也没问题**（SQLite 保证读到一致的快照）。

### 在**你自己的电脑**上操作

```powershell
# 切到项目目录（改成你自己的路径）
cd C:\Users\你的用户名\dshworkplace\学习守护平台

# 打一个干净快照
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/app.db');d.exec(\"VACUUM INTO 'data/migrate.db'\");console.log('快照完成')"

# 传到服务器（把 IP 换成你的）
scp data/migrate.db  root@你的公网IP:/tmp/
scp data/secret.key  root@你的公网IP:/tmp/
scp -r data/uploads  root@你的公网IP:/tmp/uploads
```

> 如果提示 `scp` 不是命令：它的替代品是 WinSCP 或 FileZilla，图形界面拖拽即可。
> Windows 10/11 一般自带 `scp`。

### 在**服务器**上操作

```bash
cd /opt/study-guardian
pm2 stop study-guardian

mkdir -p data
mv /tmp/migrate.db data/app.db
mv /tmp/secret.key data/secret.key
rm -rf data/uploads && mv /tmp/uploads data/uploads

pm2 start study-guardian
```

`secret.key` 一起搬过去，登录状态才不会失效（不搬也能用，只是要重新登录一次）。

**搬完刷新页面，课程、作业、推送配置就都在了。**

---

## 以后怎么更新代码

```bash
cd /opt/study-guardian
git pull
pm2 restart study-guardian
```

---

## 备份（强烈建议做）

数据全在 `/opt/study-guardian/data` 一个目录里，备份就是打包这个目录。

```bash
crontab -e
```

在末尾加上这一行（保存方式同 nano）：

```
0 3 * * * cd /opt/study-guardian && tar czf /root/backup-$(date +\%F).tgz data && find /root -name 'backup-*.tgz' -mtime +14 -delete
```

这样每天凌晨 3 点自动打包一次，并只保留最近 14 天。

> ⚠️ 云服务器是**租的**，到期不续费数据就没了。
> 而且备份和原数据在同一台机器上，机器本身坏了两份都没了。
> **偶尔下载一份到本地**（用 WinSCP 或 `scp root@你的IP:/root/backup-*.tgz .`）更稳妥。

---

## 省流量与防刷（用「按流量计费」的话必看）

如果你的服务器是**按使用流量**计费（出站约 ¥0.80/GB），那出站流量就是钱。
这个项目已经内置了两层防护，另外还有两件事要你去控制台做。

### 已经内置的：gzip 压缩

服务会自动对文本内容 gzip。实测效果：

| 内容 | 压缩前 | 压缩后 |
| --- | --- | --- |
| `app.js` | 107 KB | **31 KB** |
| `app.css` | 95 KB | **22 KB** |
| 设置页 HTML | 58 KB | **11 KB** |
| 课程表页 HTML | 42 KB | **7 KB** |

静态资源和每个动态页面都省掉 **七到八成**。
图片、PDF、视频这些本来就是压缩格式，程序会跳过不压（不浪费 CPU）。

**这是自动的，不用配置。** 唯一需要注意的是：如果前面挂了反向代理，
别让代理把 `Accept-Encoding` 头吃掉。

### 已经内置的：限流

| 对象 | 默认 | 说明 |
| --- | --- | --- |
| 普通请求 | 300 / 分钟 | 打开一个 71 页课件要 70 多次请求，所以不能设太小 |
| 登录 / 注册接口 | 1 / 分钟（突发 10） | 唯一能「试出密码」和「试出邀请码」的入口，必须兜住 |

想调整就改 `.env`：

```
RATE_LIMIT_PER_MIN=300
RATE_LIMIT_AUTH_PER_MIN=1
```

被限流时会返回 `429` 加一个中文提示页，带上标准的 `Retry-After` 头。

### 已经内置的：注册闸门

`INVITE_CODE` 留空就是**关闭注册**（见第 5 步）。
这是防刷的第三道：限流挡住「一秒试一百次」，
邀请码挡住「在我的服务器上建一百个号塞满磁盘」。

三道合起来是这样的：

| 想干的事 | 被谁挡住 |
| --- | --- |
| 猜你的密码 | 登录限流（1/分钟） |
| 猜邀请码 | 注册限流（同一个桶） |
| 建号占磁盘 | 没有邀请码就建不了号 |
| 疯狂拉页面刷流量 | 普通限流 + gzip |

> **放在反向代理后面时**，记得把 `TRUST_PROXY=true` 打开，
> 否则所有请求看起来都来自 `127.0.0.1`，限流会变成全局共用一个桶。
> 反过来说，**没挂代理时千万别打开它** —— 那就等于允许别人伪造 IP 绕过限流。

### 要你去控制台做的两件事 ⭐

**1. 设置费用预警**

> 阿里云 / 腾讯云控制台 → 费用 → **费用预警** → 设 ¥5 / ¥20 / ¥50 三档，开短信通知

这是**唯一**能发现「慢性失血」的手段：如果哪天有人每天悄悄拉 1GB，
一个月就是 ¥24，不会有任何性能告警，只有账单能看到。

**2. 带宽峰值设成 5 Mbps**

按量计费时带宽峰值**不影响价格**，它只是限速上限 ——
但它同时是**损失速度的刹车**：

| 带宽峰值 | 被打满一天的损失 |
| --- | --- |
| **5 Mbps** | **约 ¥43** |
| 20 Mbps | 约 ¥173 |
| 100 Mbps | 约 ¥864 |

5 Mbps 日常完全够用：打开网页约 0.4 秒，看一份 14MB 的课件约 22 秒。

### 还有一件事：用强密码

因为这个应用**没有登录失败锁定**（限流是后来补的，只能减慢而不能杜绝），
密码就是唯一的门。建议 16 位以上、别和其它网站重复。

---

## 常见问题

<details>
<summary><b>同学打不开注册 / 说用户名被占用了</b></summary>

分三种情况，从前往后查：

**1. 注册那一栏写着「本站暂未开放自助注册」**

`.env` 里的 `INVITE_CODE` 是空的 —— 也就是注册关着（这是默认状态）。
填上邀请码再重启：

```bash
cd /opt/study-guardian
sed -i 's/^INVITE_CODE=.*/INVITE_CODE=你的邀请码/' .env
pm2 restart study-guardian
```

设完打开网站自己看一眼：注册那一栏应该冒出「邀请码」输入框了。

**2. 提示「用户名已经被占用了」**

用户名是**不区分大小写**的唯一：`Winkie` 和 `winkie` 算同一个。
换个名字就行（提示里会写清是哪个名字被占了）。

**3. 提示「邀请码不正确」**

邀请码区分大小写，也别带多余的空格。
实在对不上就干脆改成新的，或者用命令行直接给他建号：

```bash
node scripts/create-user.mjs 用户名 密码
```

</details>

<details>
<summary><b>有人注销了账号，数据真的没了吗？能恢复吗</b></summary>

**没了。** 注销是立即、彻底、不可撤销的：

- 数据库里这个人的课表、作业、课件、提醒、推送记录全部删除
- 磁盘上他上传的课件、转换出的 PDF、幻灯片图片也一并删掉
- 会话立刻失效，用户名随之释放（别人可以注册同一个名字）

唯一能补救的是**你自己手上的备份**（见「备份」那一节）。
所以：注销前先让它把 `data/` 目录备一份。

按设计，注销要**输对密码 + 把用户名原样敲一遍**两道确认。
这不是为了难为用户，是因为它没有回收站。

</details>

<details>
<summary><b>新传的课件打开只有文字，没有排版（以前的能正常看）</b></summary>

老课件的 PDF 早就转好放在缓存里了，不用重新转，所以**只有新传的会暴露问题**。
原因几乎总是「转 PDF 这一步失败了」。

在服务器上跑一次诊断，它会把原因直接打出来：

```bash
cd /opt/study-guardian
node scripts/diagnose-preview.mjs
```

它会检查：磁盘剩多少、内存够不够、有没有上次超时后留下的僵尸进程、
转换器还在不在、最近传的每份课件各自是什么状态和原因。

**最常见的两个原因：**

**① LibreOffice 没装（或者在系统更新里被删掉了）**

```bash
sudo apt update
sudo apt install -y libreoffice-impress libreoffice-writer libreoffice-calc
pm2 restart study-guardian
```

> 装之前先看一眼诊断里「转换器状态」那一节 ——
> 如果它显示可用，就别装，那是别的原因。

**② 上次转换超时，留下的僵尸进程把内存吃光了**

```bash
pkill -f soffice          # 清掉残留进程
rm -rf data/cache/lo-profile-* data/cache/*.log   # 清掉残留的临时目录
pm2 restart study-guardian
```

诊断里「残留的 LibreOffice 进程」那一节会告诉你有没有这种情况。

**为什么会出现②**：转换超过 120 秒会被强制结束，而旧版本只杀得掉外层脚本、
杀不掉真正的 `soffice.bin`。它就一直占着内存，越积越多，
最后新的一次转换必然失败。这个已经在代码里修了（现在会连整棵进程树一起收），
但如果服务器上已经积了一批，得按上面的命令手动清一次。

**转换器没问题、只是上次临时失败了**，可以直接重试：

```bash
node scripts/diagnose-preview.mjs --retry
```

</details>

<details>
<summary><b>一次传了好几个课件，后面的半天没反应</b></summary>

这是**排队**，不是卡住。预览转换默认同时只跑 1 个
（`PREVIEW_CONCURRENCY=1`）。

为什么不让它一起跑：上传接口把转换丢到后台就立刻返回，所以连着传几个
课件时本来是会同时在跑的。LibreOffice 每个实例要几百 MB 内存，
2 核 2G 的服务器上 3 个就能把内存打满、被系统杀掉 ——
代价是所有转换**全都失败**。

串行只是慢一点：一份课件十几秒，排在后面的多等一会儿。
页面刷新后状态会从「正在生成预览」变成正常。

内存够大（4GB 以上）想换点速度，可以改 `.env`：

```
PREVIEW_CONCURRENCY=2
```

</details>

<details>
<summary><b>浏览器一直转圈打不开</b></summary>

九成是第 1 步的安全组没放行 3081 端口。先在服务器上确认服务本身是活的：

```bash
pm2 status
curl -I http://127.0.0.1:3081/login
```

- 服务器上能通、外面打不开 → **安全组问题**
- 服务器上也通不了 → 看 `pm2 logs study-guardian` 的输出

</details>

<details>
<summary><b>提醒时间不对，或者晚了 8 小时</b></summary>

时区没配。检查 `.env` 里有没有 `TZ=Asia/Shanghai`，改完重启：

```bash
pm2 restart study-guardian
```

</details>

<details>
<summary><b>重启服务器后网站打不开了</b></summary>

`pm2 startup` 那一步没做完。重新执行：

```bash
pm2 startup
# 把它打印出来的那一整行命令复制粘贴执行
pm2 save
```

</details>

<details>
<summary><b>想换成好看的域名和 HTTPS</b></summary>

国内服务器一旦**用域名**对外提供服务，就必须**备案**（个人备案要约 1–3 周）。
不想备案的话，可以换成**香港轻量服务器 + 域名**，代价是跨境访问可能慢一些、偶尔丢包。

详见 README 的部署章节。

</details>

<details>
<summary><b>内存不够，PPT 转换老是失败</b></summary>

LibreOffice 转换比较吃内存。升到 2G 以上，或者干脆关掉自动转换：

```
ENABLE_OFFICE_CONVERT=false
```

关掉之后 PPT 会用内置解析器渲染成网页版预览（能看内容，但没有原排版）。

</details>

---

## 也可以直接用 Docker

如果你更熟悉容器，项目里已经准备好了 `Dockerfile` 和 `docker-compose.yml`，
镜像里装好了 LibreOffice、中文字体和时区，一条命令就行：

```bash
git clone https://github.com/Winkiey/study-guardian.git && cd study-guardian
docker compose up -d
```

数据存在名为 `study-data` 的 Docker volume 里，容器重建不会丢。

> 注意：用 Docker 时端口由 `docker-compose.yml` 的 `3081:3081` 决定，
> 照样要在安全组里放行 3081。
> 但从宿主机访问这个 volume 里的文件要绕一层，**数据迁移会比上面 Node 的方式麻烦一点**，
> 所以本指南推荐直接用 Node + pm2。
