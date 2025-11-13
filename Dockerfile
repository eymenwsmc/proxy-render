# Playwright resmi image Chromium ve gerekli paketlerle gelir
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /usr/src/app

# package.json önce kopyala ve install et (cache için)
COPY package.json ./ 
RUN npm install --production


# Kalan dosyaları kopyala
COPY . .

# Port (app içinde process.env.PORT kullanıyorsan Render bunu sağlar)
EXPOSE 3000

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright


# Start
CMD ["node", "server.js"]
