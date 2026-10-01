# BabyAlbum 宝宝相册

把 NAS、服务器或网盘上多年积累的照片和视频，按宝宝的年龄自动整理成家庭相册。

- **按年龄看**：“3 个月”“1 岁 2 个月”，而不是一堆日期文件夹
- **自动认出宝宝**：人脸识别找出所有有宝宝的照片，不用手动整理
- **照片原地不动**：只读访问存储（SMB、NFS、WebDAV），不复制、不移动、不修改任何文件
- **家人一起看**：给家人开账号或发免登录链接，可以限定只看哪个宝宝
- **像 App 一样用**：手机上添加到主屏幕，全屏浏览，宝宝生日、满月那天推送回顾
- **一条命令部署**：不需要任何配置文件，存储连接、成员、各项设置都在网页上完成

后台引擎使用开源相册 [Immich](https://immich.app)（扫描、缩略图、人脸识别），家人不需要接触它。

## 功能

**相册**

| 功能 | 说明 |
|---|---|
| 时间线 | 宝宝的照片和视频按月龄分组，滚动自动加载 |
| 回顾 | 每个月、每一年自动挑一组精选（优先收藏的、宝宝脸大的，连拍只留一张，尽量每天/每月都有），可以连起来播放；生日、满月后首页提醒 |
| 成长墙 | 每个月龄一张代表照片（优先选收藏的），可以连起来播放 |
| 那年今日 | 往年同一天的照片，首页会提醒 |
| 里程碑 | 记录第一次翻身、第一次走路，可以配上当天的照片 |
| 日记 | 给某一天写几句话，和当天的照片放在一起 |
| 成长书 | 把每个月的代表照片、里程碑、日记、成长数据排成一本书，用浏览器打印成 PDF |
| 成长数据 | 记录身高、体重、头围，画出曲线，和 WHO 儿童生长标准（0–5 岁）的百分位对比 |
| 搜索 | 用一句中文找照片：“在海边”“吃蛋糕”“荡秋千”（Immich 的语义搜索，默认使用多语言模型） |
| 地图 | 按拍摄地点看照片：照片按位置聚在一起，点开看这个地方拍的所有照片；列出去过的地方。底图可选 OpenStreetMap 或高德地图（自动换算坐标） |
| 同龄对比 | 几个宝宝在同一个月龄时的照片并排看（满月、百天、周岁……） |
| 看照片 | 大图、视频播放、实况照片（打开自动播放，手机上长按播放）、双指缩放、滑动切换、下滑关闭、收藏、下载原图、拍摄信息 |
| 日期更正 | 自动找出日期明显不对的照片和视频（比如影楼相册设计页、相机时间没调、视频没有拍摄时间），按同一文件夹其他照片的日期一键更正 |
| 手机 | 可以添加到主屏幕（PWA），底部导航；打开通知后，宝宝生日、满月那天早上推送回顾 |

**家人与分享**

| 功能 | 说明 |
|---|---|
| 成员 | 管理员 / 家人 / 只读三种角色，可以限定只看某几个宝宝 |
| 邀请 | 生成邀请链接，家人打开后自己设置用户名和密码 |
| 分享链接 | 免登录的只读链接，对方只能看到有宝宝的照片。可设有效期、访问密码、是否允许下载原图，给长辈的可以打开“长辈模式”（字和照片更大），随时修改、停用 |

**管理（管理员）**

| 功能 | 说明 |
|---|---|
| 存储 | 连接存放照片的 NAS、服务器或网盘，支持 SMB、NFS、WebDAV，可以添加多个；测试连接，断开后自动重连 |
| 照片库 | 浏览存储里的文件夹，勾选要导入的；导入进度：照片、视频各还剩多少，最近的速度，预计还要多久 |
| 人物 | 给识别出的人物命名、设生日、隐藏路人，合并被拆开的同一个人。照片很多的人物会主动提示“是宝宝吗？”，并列出从没和 TA 同框过、可能是同一个人的其他人物 |
| 整理 | Immich 找出的疑似重复照片，标出建议保留哪张；多余的可以在相册里隐藏（不删除存储上的文件，随时能恢复） |
| 系统设置 | 视频转码、人脸识别、语义搜索模型、地图底图、处理速度、定时扫描、数据库备份 |

## 架构

```
 存储（SMB / NFS / WebDAV，可多个）
   │ 只读
   ▼
 nas-mounter ──挂载──▶ Immich（扫描、缩略图、人脸识别、搜索）
 （挂载服务）              │ API
                          ▼
                     baby-server（宝宝相册：网页 + API） ◀── 浏览器 / 手机 :3000
```

| 服务 | 作用 |
|---|---|
| `baby-server` | 宝宝相册的网页和后端，唯一对外开放的服务。管理用户、权限、宝宝档案、里程碑，并在后台配置 Immich |
| `nas-mounter` | 按宝宝相册的指令挂载存储（SMB、NFS 由内核挂载，WebDAV 用 rclone）。挂载需要系统权限，所以单独成一个容器，不对外开放端口 |
| `immich-server`、`immich-machine-learning` | Immich 官方镜像，只在内部使用，不对外开放端口 |
| `database`、`redis` | Immich 的数据库和缓存 |

宝宝相册第一次启动时会自动初始化 Immich，不需要手动配置。

## 项目结构

```
BabyAlbum/
├── docker-compose.yml        # 全部服务
├── docker-compose.nas.yml    # 直接部署在绿联 NAS 上时叠加（硬件转码）
├── docker-compose.dev.yml    # 本机测试时叠加
├── .env.example              # 可选配置
├── baby-server/              # 后端（TypeScript + Fastify + SQLite）
│   ├── src/
│   │   ├── routes/           # 接口：相册、管理、分享
│   │   ├── mounter/          # 挂载服务
│   │   ├── album.ts          # 时间线、成长墙、那年今日、回顾选片、搜索、实况照片
│   │   ├── auth.ts           # 登录、角色权限、邀请
│   │   ├── import-progress.ts # 导入进度和剩余时间估算
│   │   ├── map.ts            # 地图：照片位置、去过的地方
│   │   ├── push.ts           # 手机推送（生日、满月回顾）
│   │   ├── immich-link.ts    # 自动接入 Immich
│   │   ├── nas.ts            # 存储连接管理
│   │   └── db.ts             # 数据库
│   └── scripts/              # 测试数据生成
├── baby-web/                 # 前端（React + Vite）
└── scripts/
    ├── inventory.ts          # NAS 照片盘点工具
    ├── fix-mtime.ts          # 按文件名修正照片日期的工具
    ├── who-growth.py         # 从 WHO 官网下载生长标准数据，生成前端用的数据文件
    └── dev-up.sh             # 一键启动本机测试环境
```

## 部署

**需要**：一台能运行 Docker 的电脑（Mac、Linux、带 Docker 的 NAS 都可以），和存放照片的存储：开启了 SMB 或 NFS 的 NAS / 服务器，或者 WebDAV 网盘。

### Mac（推荐 Mac mini，常年开机）

1. 安装 [OrbStack](https://orbstack.dev)，设置里勾选“登录时启动”。
2. 在 **系统设置 → 隐私与安全性 → 本地网络** 里允许 OrbStack，否则连不上局域网里的存储。
3. 下载本项目，在项目文件夹里运行：
   ```bash
   docker compose up -d
   ```
4. 打开 `http://<这台 Mac 的 IP>:3000`，按下面的“首次使用”操作。

作为常年运行的服务器，建议再设置一下：

```bash
sudo pmset -a sleep 0 disksleep 0     # 不睡眠（显示器可以照常关闭）
sudo pmset -a autorestart 1           # 停电恢复后自动开机
```

并在 **系统设置 → 用户与群组** 中开启自动登录，这样重启后所有服务都会自动启动。首次导入要从存储读取大量数据，建议用网线连接。

### Linux / 带 Docker 的 NAS

```bash
docker compose up -d
```

直接部署在绿联 NAS（如 DX4600）上时，新建 `.env` 写入下面一行，叠加 Intel 核显硬件转码，然后再启动：

```
COMPOSE_FILE=docker-compose.yml:docker-compose.nas.yml
```

照片就在这台 NAS 上时，添加存储的地址填 `127.0.0.1`。建议内存 16GB；缩略图和数据库放到 SSD 上会更快，见 `docker-compose.nas.yml` 里的注释。

### 可选配置

不建 `.env` 也能运行。需要修改端口、时区等时，复制 `.env.example` 为 `.env` 再改，每一项都有说明。

### 升级

```bash
git pull
docker compose up -d --build
```

Immich 锁定在 v3 大版本。要升级 Immich 大版本前，先看它的 [更新说明](https://github.com/immich-app/immich/releases)。

## 首次使用

1. **创建管理员**：第一次打开网页时创建。宝宝相册会在后台自动初始化 Immich，大约需要一分钟。
2. **添加存储**（管理 → 照片库）：选连接方式，填写地址和账号，点“测试连接”，成功后保存。
   - **SMB**：大多数 NAS、Windows、macOS 的共享文件夹。共享名就是在电脑上连接时看到的第一层共享文件夹。建议给宝宝相册单独建一个**只读账号**。
   - **NFS**：Linux 服务器、开启了 NFS 的 NAS。填共享路径（比如 `/volume1/photos`），并在 NFS 设置里允许运行宝宝相册的这台设备的 IP。
   - **WebDAV**：网盘或开启了 WebDAV 的服务器。填完整地址（比如 `https://dav.example.com/dav`）。读取大量照片和视频比较慢，首次导入会花更长时间。
3. **设置备份位置**（同一页）：选一个存储上可写的文件夹，数据库每天自动备份到那里。
4. **添加照片库**：浏览存储，勾选存放照片的文件夹，保存后自动开始扫描。照片很多时，建议先选一两个文件夹试一下。
5. **添加宝宝**（首页）：等人脸识别有结果后，选出宝宝的脸，填写名字和生日。
   - 宝宝小时候和现在长得不一样，可能被识别成好几个人物。到 **管理 → 人物** 里点开宝宝，把其他几个合并进来。
6. **邀请家人**（管理 → 成员）：生成邀请链接发给家人，可以选角色、限定只看哪个宝宝。

处理速度参考：几百张照片几分钟；几万张照片和视频大约一天（只在第一次导入时这么久，之后只处理新照片）。

## 常见问题

**连不上存储？**
“测试连接”会给出具体原因。常见的：SMB 没开启或账号密码不对；NFS 没有允许这台设备的 IP；WebDAV 地址不完整。宝宝相册运行在 Mac 上时，还要在“本地网络”权限里允许 OrbStack。

**视频播放不了？**
为了节省时间和空间，默认**不转码**，由浏览器直接播放原视频。苹果设备和 Mac 上的 Chrome 都能播放手机常见的 HEVC 视频；部分安卓手机、微信内置浏览器可能不行。需要的话在 **管理 → 系统设置 → 视频** 里打开转码（会比较耗时间和空间）。

**怎么让家人在外面也能看？**
在宝宝相册前面加一个 HTTPS 反向代理（比如 NAS 自带的反向代理、Caddy、Nginx Proxy Manager），只暴露 3000 端口，反向代理需要传递 `X-Forwarded-For` 和 `X-Forwarded-Proto`（常见反代默认都会），通过 HTTPS 访问时登录 Cookie 会自动加上 Secure 标记。只给自己人用的话，也可以用 Tailscale 这类组网工具，不用暴露任何端口。

**新拍的照片怎么进来？**
放到存储上已导入的文件夹里，定时扫描（默认每天一次）后自动出现，也可以在照片库页面手动扫描。

**照片日期不对？**
- 日期早于出生之类明显错误的，宝宝页面会提示，一键更正即可（只在宝宝相册里生效，不改原文件）。
- 微信保存的图片等没有拍摄时间的照片，可以用 `scripts/fix-mtime.ts` 按文件名里的时间修正（只改文件修改时间，默认只预览）：
  ```bash
  docker run --rm -v /照片目录:/photos -v "$PWD/scripts:/s:ro" node:24-alpine node /s/fix-mtime.ts /photos          # 预览
  docker run --rm -v /照片目录:/photos -v "$PWD/scripts:/s:ro" node:24-alpine node /s/fix-mtime.ts /photos --apply  # 执行
  ```

**部署前想先看看 NAS 上有多少照片？**
`scripts/inventory.ts` 会统计文件数量、格式、大小、重复文件，并估算需要的缓存空间。只读，不改任何文件：
```bash
docker run --rm -v /照片目录:/photos:ro -v "$PWD/scripts:/s" node:24-alpine node /s/inventory.ts /photos --out /s/report.json
```

**忘记密码？**
家人忘记密码由管理员在“成员”里重置。管理员忘记密码，在服务器上运行：
```bash
docker compose exec baby-server node --disable-warning=ExperimentalWarning src/cli/reset-password.ts <用户名> <新密码>
```

**数据存在哪里？**
- 照片：始终在原来的存储上，只读访问。
- 缩略图、数据库：在运行宝宝相册的电脑上（Docker 数据卷）。
- 备份：每天自动备份到设置的文件夹。存储的账号密码也在数据库里，会随备份一起保存，请妥善保管备份文件夹。

## 开发

需要 Node.js 24 以上、Docker 和 ffmpeg（生成测试照片用）。

```bash
./scripts/dev-up.sh
```

一键启动本机测试环境：生成测试照片（两个宝宝，约三年的数据），启动所有服务并初始化。完成后打开 http://localhost:3000，账号密码在 `dev-data/dev-credentials.json`。

```bash
# 后端：Node 直接运行 .ts，没有构建步骤
cd baby-server && npm install
npm run dev          # 开发模式（需要能访问 Immich，IMMICH_URL 默认 http://localhost:2283）
npm run typecheck && npm test

# 前端：Vite 开发服务器，/api 代理到 localhost:3000
cd baby-web && npm install
npm run dev
npm run typecheck
```

## 许可证

[GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）。

可以自由使用、修改和分发。修改后的版本如果通过网络提供给别人使用，也必须以同样的许可证公开源代码。

本项目通过 API 调用 [Immich](https://github.com/immich-app/immich)（同样是 AGPL-3.0），使用它的官方 Docker 镜像，没有包含或修改 Immich 的源代码。

成长曲线使用 [WHO 儿童生长标准](https://www.who.int/tools/child-growth-standards/standards)（2006）的 LMS 参数，由 `scripts/who-growth.py` 从 WHO 官网的表格生成。
