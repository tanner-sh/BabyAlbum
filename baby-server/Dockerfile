# 构建上下文是仓库根目录（见 docker-compose.yml）

# ---- 前端构建 ----
FROM node:24-alpine AS web
WORKDIR /web
COPY baby-web/package.json baby-web/package-lock.json ./
RUN npm ci
COPY baby-web/ ./
RUN npm run build

# ---- 宝宝相册：Node 24 直接运行 .ts，无需编译 ----
FROM node:24-alpine AS app
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 WEB_DIR=/app/web
COPY baby-server/package.json baby-server/package-lock.json ./
RUN npm ci --omit=dev
COPY baby-server/src ./src
COPY --from=web /web/dist ./web
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]

# ---- 挂载服务：在宝宝相册的基础上加挂载工具（NFS、WebDAV） ----
# SMB 和 NFS 由内核直接挂载；WebDAV 内核不支持，用 rclone 通过 FUSE 挂载
FROM app AS mounter
RUN apk add --no-cache nfs-utils rclone fuse3
CMD ["node", "--disable-warning=ExperimentalWarning", "src/mounter/main.ts"]
