# ============================================================
# 学习守护平台 · Docker 镜像
#
# 注意这里**没有 npm install**：本平台零第三方依赖，
# 直接把源码拷进去就能跑。唯一的系统依赖是 LibreOffice（把 PPT/Word 转成 PDF 用）。
#
# 构建： docker build -t study-guardian .
# 运行： docker run -d -p 3081:3081 -v study-data:/data --name study-guardian study-guardian
# ============================================================

FROM node:24-bookworm-slim

# LibreOffice 负责把 PPT / Word / Excel 转成 PDF，这样浏览器才能内嵌预览。
# 中文字体必须装，否则转出来的 PDF 里中文会变成方块。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-impress \
        libreoffice-writer \
        libreoffice-calc \
        fonts-noto-cjk \
        fonts-noto-cjk-extra \
        fonts-wqy-zenhei \
        ca-certificates \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

# 时区：课表和作业 DDL 都按本地时间计算，容器里默认是 UTC，必须显式设置
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 零依赖，所以直接整份拷进去即可，不需要 package.json 分层缓存那一套
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3081 \
    DATA_DIR=/data \
    HOME=/tmp

# 所有可变数据都在 /data：数据库、上传的课件、转换缓存、会话密钥
VOLUME ["/data"]
EXPOSE 3081

# 健康检查：访问登录页，能返回就算活着
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3081)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
