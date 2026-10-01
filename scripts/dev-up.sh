#!/bin/sh
# 本机 OrbStack 一键启动测试环境：生成测试照片 → 启动 Immich → 初始化 → 构建并启动宝宝相册
set -e
cd "$(dirname "$0")/.."

# 本机测试叠加 dev 覆盖配置
export COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml

echo "==> 生成测试照片"
(cd baby-server && node scripts/make-samples.ts ../dev-data/sample-photos)

# 测试照片挂在只读的 NAS 目录下面，挂载点要先在宿主机上建好（OrbStack 虚拟机里的目录）
docker run --rm -v /var/lib/babyalbum:/h alpine mkdir -p "/h/nas/测试照片"

echo "==> 构建并启动（宝宝相册会自动初始化 Immich）"
docker compose up -d --build database redis nas-mounter immich-server baby-server

# 测试照片通过 tar 流复制进数据卷（不挂载宿主机目录，原因见 docker-compose.dev.yml）
if [ "$(docker run --rm -v babyalbum_dev-photos:/p alpine sh -c 'ls -A /p | wc -l')" = "0" ]; then
  echo "==> 复制测试照片到数据卷"
  tar -C dev-data/sample-photos -cf - . | docker run --rm -i -v babyalbum_dev-photos:/p alpine tar -C /p -xf -
fi

echo "==> 初始化测试数据"
(cd baby-server && node scripts/dev-seed.ts)
echo "完成：http://localhost:${BABY_PORT:-3000}（账号密码见 dev-data/dev-credentials.json）"
