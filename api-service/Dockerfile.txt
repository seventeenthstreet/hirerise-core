FROM node:20-alpine AS base
WORKDIR /app

COPY package.json ./
RUN npm install --production --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "src/server.js"]
