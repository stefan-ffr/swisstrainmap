FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
