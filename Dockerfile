FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# Wagenzeichnungen von reisezuege.ch (mit Erlaubnis) einmal ins Image laden;
# eigene Schicht vor dem Code, damit sie bei Code-Änderungen erhalten bleibt
COPY scripts/fetch-drawings.js ./scripts/
RUN node scripts/fetch-drawings.js /app/drawings
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
