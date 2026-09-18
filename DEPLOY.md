# 部署到云服务器（用 IP 访问，免备案）

> **目标**：租一台国内轻量应用服务器，把这个平台变成一个**随时输网址就能打开的网站**，
> 不再依赖你自己的电脑开着。
>
> 全程约 20 分钟。**不需要备案** —— 备案只针对域名，直接用 IP 地址访问不涉及。

---

## 需要准备什么

- 一台**轻量应用服务器**：系统选 Ubuntu 22.04 或 24.04，**内存 2G 起**
  - 为什么至少 2G：PPT 转 PDF 走 LibreOffice，转大课件时内存会冲高，1G 容易在转换时被系统杀掉
  - 学生认证通常有优惠价，具体看云厂商当期活动
- 服务器的**公网 IP** 和 **root 密码**（买完在控制台首页就能看到）

---

## 第 1 步：放行端口（最容易漏的一步）

云服务器默认只开 22 端口。去控制台找到 **安全组 / 防火墙**，添加两条**入站**规则：

| 端口 | 协议 | 说明 |
| --- | --- | --- |
| 22 | TCP | SSH 登录（一般已经默认有） |
| **3081** | TCP | 打开这个平台 |

> ⚠️ 这一步漏了，浏览器会一直转圈直到超时。很多人会误以为是程序没跑起来，
> 然后在服务器上反复折腾 —— 其实程序好得很，是外面进不来。

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
sudo apt install -y libreoffice-impress fonts-noto-cjk

# 让服务常驻后台、开机自动启动
sudo npm install -g pm2
```

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

## 第 5 步：配置时区（重要，别跳过）

```bash
cp .env.example .env
nano .env
```

确认里面有这两行（`Ctrl+O` 回车保存，`Ctrl+X` 退出）：

```
HOST=0.0.0.0
TZ=Asia/Shanghai
```

- **`HOST=0.0.0.0`** —— 不写的话只监听本机，外面根本打不开
- **`TZ=Asia/Shanghai`** —— 云服务器默认时区**常常是 UTC**。
  不写的话所有提醒会**迟发 8 小时，而且不报任何错**，只有到点了收不到推送才会发现

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

## 常见问题

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
