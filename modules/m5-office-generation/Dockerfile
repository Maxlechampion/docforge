FROM node:20-alpine
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-fra
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY src ./src
EXPOSE 3005
CMD ["node", "src/index.js"]
