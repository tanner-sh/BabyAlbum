#!/bin/sh
# 给本机测试环境补充测试数据（在 dev-up.sh 之后运行，可以重复运行）：
# - 40 张带 GPS 的照片（上海 20、哈尔滨 12、东京 8）：测地图
# - 一对实况照片 实况测试/IMG_9001.JPG + IMG_9001.MOV，视频的日期和照片不同：测实况配对
# - 小宝文件夹里一个日期早于出生的视频（没有人脸）：测日期检查
# 用 Immich 镜像里自带的 exiftool 和 ffmpeg，本机不用另外安装
set -e
cd "$(dirname "$0")/.."

IMAGE=$(docker inspect immich_server --format '{{.Config.Image}}')
EXIFTOOL='perl $(find /usr/src/app/server/node_modules -path "*exiftool-vendored.pl*/bin/exiftool" | head -1)'

echo "==> 写入测试数据"
docker run --rm --entrypoint sh -v babyalbum_dev-photos:/p "$IMAGE" -c "
set -e
EXIF=\"$EXIFTOOL\"

# GPS：2024 年小宝的前 40 张照片
i=0
for f in \$(find /p/2024 -name 'xb_IMG_*.jpg' ! -name '._*' | sort | head -40); do
  i=\$((i+1))
  if [ \$i -le 20 ]; then lat=31.23\$i; lon=121.47\$i; elif [ \$i -le 32 ]; then lat=45.80\$i; lon=126.53\$i; else lat=35.68\$i; lon=139.76\$i; fi
  eval \$EXIF -q -overwrite_original -GPSLatitude=\$lat -GPSLatitudeRef=N -GPSLongitude=\$lon -GPSLongitudeRef=E \"\$f\"
done
echo \"  GPS：\$i 张\"

# 实况：照片 + 同名的短视频（视频带着另一个拍摄时间，两者在时间线上不会挨在一起）
photo=\$(find /p -name 'eb_IMG_*.jpg' ! -name '._*' | sort | head -1)
video=\$(find /p -name '*_VID_*.mp4' ! -name '._*' | sort | head -1)
mkdir -p /p/实况测试
cp \"\$photo\" /p/实况测试/IMG_9001.JPG
ffmpeg -loglevel error -y -i \"\$video\" -c copy -metadata creation_time=2020-01-01T10:00:00Z -f mov /p/实况测试/IMG_9001.MOV
echo '  实况：实况测试/IMG_9001.JPG + IMG_9001.MOV'

# 出生前的视频：放在小宝 2023 年的第一个文件夹里
folder=\$(dirname \$(find /p/2023 -name 'xb_IMG_*.jpg' ! -name '._*' | sort | head -1))
ffmpeg -loglevel error -y -i \"\$video\" -c copy -metadata creation_time=2022-03-01T10:00:00Z \"\$folder/VID_PREBIRTH.mp4\"
echo \"  出生前的视频：\${folder#/p/}/VID_PREBIRTH.mp4\"
"

echo "==> 重新扫描照片库，等待处理完"
(cd baby-server && node --disable-warning=ExperimentalWarning scripts/dev-rescan.ts)
