FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production \
    DB_FILE=/data/raspisanie.db \
    TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "server.js"]
