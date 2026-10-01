# BabyAlbum 宝宝相册

接管 NAS 上已有的照片和视频（几 TB 到十几 TB 都没问题），按宝宝年龄整理成家庭相册。

Immich 只在后台工作（扫描、缩略图、转码、人脸识别、搜索），家人不需要知道它的存在。用户、权限和 Immich 的系统设置，都由宝宝相册的管理员在网页上完成，不需要打开 Immich 的界面，也不需要改 Docker 配置。

## 功能

| 功能 | 说明 |
|---|---|
| 时间线 | 宝宝的所有照片和视频按拍摄时间倒序排列，按月龄分组（“3 个月”、“1 岁 2 个月”），滚动时自动加载 |
| 成长墙 | 每个月龄选一张代表照片（优先选收藏的），可以连起来播放 |
| 那年今日 | 往年同一天的照片，首页也会提醒 |
| 里程碑 | 记录第一次翻身、第一次走路等，可以用当天的照片当封面；看照片时也能一键记录 |
| 同龄对比 | 几个宝宝在同一个月龄时的照片并排看（满月、百天、周岁……） |
| 家人分享 | 生成免登录的只读链接给爷爷奶奶，可设置有效期、随时停用；对方只能看到有宝宝的照片 |
| 看照片 | 大图、视频播放（支持拖动进度条）、收藏（同步回 Immich）、下载原图、拍摄信息 |
| 日期更正 | 自动找出日期早于出生的照片（影楼相册设计页、相机时间没调），按同文件夹其他照片的日期一键更正；也可以单张修改。只在宝宝相册里生效，不改原文件 |
| 成员与权限 | 宝宝相册自己的账号体系。管理员 / 家人 / 只读三种角色，可以限定只看某几个宝宝；邀请链接注册，管理员可以重置密码、停用账号 |
| NAS 连接 | 在网页上添加多台 NAS（SMB）、测试连接、修改账号密码，断开后自动重连；设置数据库备份位置。不需要改任何配置文件 |
| 照片库管理 | 管理员在网页上浏览 NAS 文件夹、选择导入哪些；查看扫描和人脸识别进度，暂停、继续、补跑 |
| 人物管理 | 给识别出的人物命名、设生日、隐藏路人；把被拆成好几个的同一个人合并；直接设为宝宝 |
| 系统设置 | 视频转码、人脸识别、处理速度、定时扫描、数据库备份等常用 Immich 设置，中文说明，保存即生效 |

## 架构

```
NAS 原始照片和视频 ──只读挂载──▶ Immich（官方镜像，不改源码，不对外开放端口）
         │                        扫描、缩略图、转码、人脸识别、搜索
         │ 只读挂载（浏览文件夹）        │ REST API（@immich/sdk，自动创建的服务账号）
         ▼                              ▼
       baby-server（TypeScript，Fastify） ── 用户与权限、宝宝档案、里程碑、分享、日期更正（SQLite）
                                         ── 按年龄组织照片、媒体代理、Immich 配置管理
                                        │
                               baby-web（React，由 baby-server 提供）
```

- **原始文件不动**：NAS 照片目录以 `:ro` 方式挂载，Immich 和本项目都不会修改原文件。
- **数据边界**：照片、人脸、收藏以 Immich 为准；Immich 没有的数据（宝宝档案、里程碑、分享链接）存在 baby-server 自己的 SQLite 里，通过 Immich 的 person ID / asset ID 关联。**只走 API，不直接读写 Immich 的数据库。**
- **自动接入 Immich**：宝宝相册首次启动时自动初始化 Immich，创建一个内部服务账号和 API 密钥，保存在自己的数据库里。不需要手动去 Immich 里建账号、创建密钥。
- **账号与权限在宝宝相册里**：和 Immich 无关。只能看部分宝宝的成员、分享链接的访客，每次访问照片都会检查照片里是否有他能看的宝宝。
- **前端不接触 Immich**：图片和视频都由 baby-server 转发。
- **版本**：Immich 锁定在 `v3` 大版本（`.env` 的 `IMMICH_VERSION`）。升级前先看 [release notes](https://github.com/immich-app/immich/releases)，再对照官方 docker-compose.yml 检查本项目的配置。

```
BabyAlbum/
├── docker-compose.yml        # 全部服务，直接 docker compose up -d 即可
├── docker-compose.nas.yml    # 直接部署在绿联 DX4600 上：QuickSync 硬件转码
├── docker-compose.dev.yml    # 本机 OrbStack 测试
├── hwaccel.ml.yml            # Immich 官方的机器学习加速配置（OpenVINO 等）
├── .env.example
├── scripts/
│   ├── inventory.ts          # 第 0 阶段：盘点 NAS 上的照片（只读、无依赖）
│   ├── fix-mtime.ts          # 按文件名修正无 EXIF 照片的修改时间（默认只预览）
│   └── dev-up.sh             # 本机一键启动测试环境
├── baby-server/              # 后端
│   ├── src/
│   │   ├── album.ts          # 时间线、那年今日、成长墙、按月龄查询
│   │   ├── age.ts            # 月龄计算
│   │   ├── auth.ts           # 登录、首次设置、邀请注册、角色权限
│   │   ├── immich-link.ts    # 自动接入 Immich（服务账号、密钥、推荐设置）
│   │   ├── nas.ts            # NAS 连接管理（交给挂载服务挂载、定期检查重连）
│   │   ├── mounter/main.ts   # 挂载服务（nas-mounter 容器的入口）
│   │   ├── db.ts             # SQLite：用户、邀请、NAS、宝宝、里程碑、分享、日期更正、设置
│   │   └── routes/           # album（只读，登录用户和分享访客共用）、manage、admin、share
│   └── scripts/              # 测试数据生成、测试环境初始化
└── baby-web/                 # 前端（React + Vite + TanStack Query）
```

## 第 0 阶段：盘点

部署之前先统计一下 NAS 上的照片：数量、格式、大小、拍摄日期能否识别、重复文件、需要多少缓存空间。脚本只读，不修改任何文件。

```bash
# 在 NAS 上用 Docker 运行（不需要安装 Node）
docker run --rm -v /volume1/photos:/photos:ro -v "$PWD/scripts:/s" node:24-alpine \
  node /s/inventory.ts /photos --out /s/inventory-report.json
```

通过网络盘点十万个文件左右，大概要十几分钟到一小时，主要花在查找重复文件上。

## 修正拍摄日期（可选）

没有 EXIF 拍摄时间的照片（微信保存的图片、部分截图等），Immich 只能用文件修改时间当拍摄时间。文件被复制、移动过之后，修改时间变成了复制的时间，照片就会排到错误的年龄。这类文件的名字里往往带着真实时间，比如 `mmexport1707877800000.jpg`（毫秒时间戳）、`IMG_20240214_103000.jpg`。

`scripts/fix-mtime.ts` 会按文件名修正这些文件的**修改时间**，文件内容不变。只处理没有 EXIF 拍摄时间、并且文件名里的时间和当前修改时间相差超过一天的文件。

```bash
# 1. 预览（不修改任何文件）
docker run --rm -v /volume1/photos:/photos -v "$PWD/scripts:/s:ro" node:24-alpine node /s/fix-mtime.ts /photos
# 2. 确认无误后执行
docker run --rm -v /volume1/photos:/photos -v "$PWD/scripts:/s:ro" node:24-alpine node /s/fix-mtime.ts /photos --apply
# 3. 到 Immich 的 管理 → 外部图库 里点“扫描”，Immich 会重新读取这些文件的元数据
```

> 有 EXIF 但日期是错的（比如影楼相册设计页带着模板的旧日期），用宝宝相册里的“日期更正”功能处理，不需要这个脚本。
>
> 这是本项目唯一会写原始文件（修改时间）的操作，所以做成了单独的脚本，默认只预览。为什么不通过 Immich 修改日期：Immich 改日期要在原文件旁写 `.xmp` 附属文件，外部图库是只读挂载的，写不进去，修改会被 Immich 还原。

## 部署

整个系统只需要一条命令启动，**不需要任何配置文件**。NAS 连接、导入哪些文件夹、成员、Immich 的各项设置，都在网页上完成。

```
NAS 1、NAS 2 …（SMB）                       Mac mini（OrbStack）
  共享文件夹 ──只读────▶ nas-mounter（挂载服务）──▶ Immich ──▶ 宝宝相册 :3000
  备份文件夹 ◀──可写────┘                            数据库、缩略图：Mac 本地 SSD
```

### Mac mini（推荐）

1. 安装 [OrbStack](https://orbstack.dev)，设置里勾选“登录时启动”。在 **系统设置 → 隐私与安全性 → 本地网络** 里允许 OrbStack，否则连不上 NAS。
2. 让 Mac mini 一直开着、不睡眠：
   ```bash
   sudo pmset -a sleep 0 disksleep 0     # 不睡眠（显示器可以照常关闭）
   sudo pmset -a autorestart 1           # 停电恢复后自动开机
   ```
   并在 系统设置 → 用户与群组 中开启自动登录，这样重启后 OrbStack 和所有服务都会自动启动。
3. **用网线连接**。首次导入要从 NAS 读取大量数据，Wi-Fi 会慢很多。
4. 把本项目文件夹拷到 Mac mini 上，在文件夹里运行：
   ```bash
   docker compose up -d
   ```
5. 打开 `http://<Mac mini 的 IP>:3000`，按下面的“首次使用”操作。

### 直接部署在绿联 DX4600 上

在 UGOS 中开启 Docker 和 SSH，把本项目放到 NAS 上，新建 `.env` 写一行 `COMPOSE_FILE=docker-compose.yml:docker-compose.nas.yml`（叠加 QuickSync 硬件转码），然后 `docker compose up -d`。添加 NAS 时地址填 `127.0.0.1`（通过 SMB 访问本机）。

N5105 + 8GB 内存能跑，但首次导入期间比较吃紧，建议升级到 16GB；缩略图和数据库放到 M.2 SSD 上更快（见 `docker-compose.nas.yml` 里的注释）。

### 可选配置

不建 `.env` 也能运行。需要改端口、时区等时，复制 `.env.example` 为 `.env` 再修改，说明见文件里的注释。

## 首次使用

1. 打开网页，**创建管理员账号**。宝宝相册会在后台自动初始化 Immich（大约一分钟）。
2. **管理 → 照片库 → 添加 NAS**：填 NAS 的地址、共享名、账号密码，点“测试连接”确认能连上，保存。
   - 共享名就是在 Mac 访达里连接 NAS 时看到的第一层文件夹（绿联通常是“用户名_硬盘名”，比如 `zhangsan_HDD1`）。
   - 建议在 NAS 上给宝宝相册单独建一个**只读账号**。
   - 有多台 NAS 就添加多个，随时可以增删，不需要重启。NAS 断开后每分钟自动重连。
3. 同一页的 **数据库备份位置**：选一台 NAS 上的文件夹（需要可写，先在 NAS 上建好，比如 `babyalbum-backup`）。Immich 和宝宝相册的数据库每天各备份一次。
4. **添加照片库**：浏览 NAS，勾选存放宝宝照片的文件夹（比如“宝宝相册”），保存后自动开始扫描。
   - 建议先只选一两个子文件夹试跑，确认没问题后再修改照片库、勾选全部。
   - 同一页下方能看到扫描、缩略图、人脸识别的进度，可以暂停或继续。
5. 等人脸识别有结果后（试跑几百张只要几分钟，全部导入大约一天），**首页 → 添加宝宝**：选出宝宝的脸，填名字和生日。
   - 同一个宝宝被识别成好几个人物（小时候和现在长得不一样），先到 **管理 → 人物** 里点开宝宝，勾选其他几个合并进来。
6. **管理 → 成员 → 邀请家人**：生成邀请链接发给家人，对方自己设置用户名和密码。可以选角色、限定只看哪个宝宝。
7. 宝宝页面如果提示有照片日期不对（影楼相册设计页之类），点开一键更正。

**视频转码**：宝宝相册第一次连接 Immich 时会自动设为“不转码”。Immich 默认只把 H.264 当作浏览器能直接播放的格式，而 NAS 上的视频几乎全是 HEVC（iPhone、大疆），按默认设置会把所有视频转码一遍，几 TB 的视频要花一到两周、额外占用上 TB 的空间。
- 不转码时，视频由浏览器直接播放 HEVC 原片。已实测 Mac 上的 Chrome 能播放大疆 4K 10-bit 和 iPhone HDR 视频，拖动进度条也正常；Safari（iPhone、iPad、Mac）完全支持。
- 可能播不了的：部分安卓手机、**微信内置浏览器**、较老的 Windows 电脑。照片不受影响。以后需要的话，在 **管理 → 系统设置 → 视频** 里改成转码即可。

### NAS 是怎么挂载的

挂载需要系统权限，所以单独放在 `nas-mounter` 容器里：它不对外开放任何端口，只通过一个 socket 文件接收宝宝相册的指令；对外提供网页的宝宝相册本身没有任何特殊权限。挂载服务用主机网络，把 NAS 挂到宿主机的 `/var/lib/babyalbum/nas/<编号>`（Mac 上是 OrbStack 虚拟机里的目录），再通过挂载传播让 Immich 和宝宝相册在运行时直接看到，所以新增、修改 NAS 都不需要重启任何容器；挂载服务自己重启也不影响已有的挂载。

NAS 的账号密码保存在宝宝相册的数据库里（和宝宝档案在一起，会随每日备份一起备份）。

### 外网访问与分享给家人

分享链接需要家人能从外网打开。建议：

- 在 baby-server 前面加一个 HTTPS 反向代理（UGOS 自带的反向代理、Caddy、Nginx Proxy Manager 都可以），只暴露 3000 端口。Immich 默认不对外开放端口。
- 走 HTTPS 时在 `.env` 里设置 `COOKIE_SECURE=true`。
- 自己人访问也可以用 Tailscale 这类组网工具，不用暴露任何端口。

### 手机自动备份

还没有接入。目前新照片需要放到 NAS 上已导入的文件夹里，定时扫描（默认每天一次）后自动出现。

## 本机测试（OrbStack）

```bash
./scripts/dev-up.sh
```

脚本会：生成约 300 张测试照片和视频（两个宝宝，约三年的数据）→ 构建并启动（宝宝相册自动初始化 Immich）→ 创建管理员 → 添加照片库并扫描 → 标注人脸、添加宝宝。完成后打开 http://localhost:3000，账号密码在 `dev-data/dev-credentials.json`。测试照片出现在 NAS 目录下的“测试照片”文件夹里，也可以在网页上再添加真实的 NAS。

重新开始：`COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml docker compose down -v`，再运行脚本。

> 本机测试不启动机器学习容器（测试图片里没有真实人脸，脚本会手动标注人脸），测试照片放在 Docker 数据卷里。原因是 OrbStack 2.2.3 + macOS 27 上，容器大量读取从 macOS 挂载进来的目录时，虚拟机会卡死。详见 `docker-compose.dev.yml`。

## 已知限制

- **没有时区信息的照片按 UTC 显示时间**：Immich 对没有 EXIF 时区的文件（主要是微信图片）按 UTC 理解时间，显示会比北京时间早 8 小时。早上 8 点前拍的这类照片，日期可能会早一天，月龄恰好在分界线上时会被分到上一个月。
- **成长墙、那年今日有 10 分钟缓存**：在 Immich 中新增照片或修改人脸后，最多 10 分钟后生效。在宝宝相册里收藏照片、修改生日会立即刷新。
- **时间线一次加载 120 张**：宝宝的照片非常多（几万张）时，滚得很远之后页面上的元素会比较多。目前用 `content-visibility` 减轻了渲染压力，手机上滚动到几千张以后如果明显变卡，可以再改成虚拟滚动。
- **忘记密码**：没有邮件找回，由管理员在“成员”里重置。管理员自己忘了密码，在服务器上运行：`docker compose exec baby-server node --disable-warning=ExperimentalWarning src/cli/reset-password.ts <用户名> <新密码>`
- **只支持 SMB**：绝大多数 NAS 都默认开启 SMB（Samba）。NFS 还没有做。
- **Immich 的高级设置**：系统设置页只开放了常用的几项。硬件加速、模型选择等高级设置，需要临时给 Immich 开放端口后在它自己的界面里改。

## 开发

需要 Node.js 24 以上。后端由 Node 直接运行 `.ts` 文件，没有构建步骤。

```bash
# 后端（读取根目录 .env；IMMICH_URL 指向 Immich，例如 http://localhost:2283）
cd baby-server && npm install
IMMICH_URL=http://localhost:2283 npm run dev
npm run typecheck && npm test

# 前端（Vite 开发服务器，/api 代理到 localhost:3000）
cd baby-web && npm install
npm run dev
npm run typecheck
```

## API

登录用户的接口在 `/api` 下；分享链接访客的只读接口在 `/api/share/:token` 下，路径结构相同（标 ☆ 的）。权限：🅰 管理员，✎ 管理员和家人，其余登录即可（只读成员只能看到被允许的宝宝）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/setup` | 是否需要首次设置 / 创建第一个管理员 |
| POST | `/api/auth/login` · `/api/auth/logout` | 登录 `{ username, password }` / 退出 |
| GET | `/api/auth/me` | 当前用户 |
| PUT | `/api/auth/password` | 修改自己的密码 `{ current, next }` |
| GET | `/api/invites/:token` · POST `/api/auth/register` | 邀请信息 / 用邀请注册 |
| GET | `/api/health` | 健康检查（含 Immich 连接状态） |
| GET/POST | `/api/babies` | 宝宝列表 / 添加 🅰 `{ name, immichPersonId, birthday? }` |
| PATCH/DELETE | `/api/babies/:id` | 🅰 修改 / 移除 |
| GET ☆ | `/babies/:id/timeline` · `/growth` · `/months/:m` · `/on-this-day` · `/milestones` | 时间线、成长墙、按月龄、那年今日、里程碑 |
| GET ☆ | `/assets/:id` · `/thumbnail` · `/video` · `/original` | 照片信息、缩略图、视频（支持 Range）、原图 |
| POST/PUT/DELETE | `/api/babies/:id/milestones` · `/api/milestones/:id` | ✎ 里程碑 |
| PUT | `/api/assets/:id/favorite` | ✎ 收藏（写回 Immich） |
| GET/POST/DELETE | `/api/babies/:id/date-issues` · `/api/date-overrides` | ✎ 日期问题、更正、恢复 |
| GET/POST/DELETE | `/api/shares` | ✎ 分享链接 |
| GET | `/api/share/:token` | 分享信息（免登录） |
| GET/POST/PATCH/DELETE | `/api/admin/users` · `/api/admin/users/:id/password` | 🅰 成员管理、重置密码 |
| GET/POST/DELETE | `/api/admin/invites` | 🅰 邀请链接 |
| GET | `/api/admin/immich` | 🅰 照片服务状态、统计、任务队列、照片库 |
| POST | `/api/admin/immich/connect` | 🅰 接入已初始化过的 Immich `{ email, password }` |
| POST | `/api/admin/immich/queues/:name` | 🅰 `{ command: start \| pause \| resume \| clear-failed }` |
| GET/PUT | `/api/admin/immich/settings` | 🅰 常用 Immich 设置 |
| GET | `/api/admin/folders?path=` | 🅰 浏览 NAS 文件夹 |
| POST/PUT/DELETE | `/api/admin/libraries` · `/:id/scan` | 🅰 照片库（导入哪些文件夹）、扫描 |
| GET/POST/PUT/DELETE | `/api/admin/nas` · `/:id/reconnect` | 🅰 NAS 连接（SMB） |
| POST | `/api/admin/nas/test` | 🅰 测试连接，返回共享里的顶层文件夹 |
| PUT | `/api/admin/backup` | 🅰 备份位置 `{ sourceId, subPath }`（`sourceId: null` 表示本机） |
| GET/PUT | `/api/admin/people` · `/:id` | 🅰 人物列表、命名、生日、隐藏 |
| POST | `/api/admin/people/:id/merge` | 🅰 合并人物 `{ ids }` |

## 许可证

[GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）。

可以自由使用、修改和分发。修改后的版本如果通过网络提供给别人使用，也必须以同样的许可证公开源代码。

本项目通过 API 调用 [Immich](https://github.com/immich-app/immich)（同样是 AGPL-3.0），使用它的官方 Docker 镜像，没有包含或修改 Immich 的源代码。
