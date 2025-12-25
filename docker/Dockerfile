FROM node:20-alpine

# Установка зависимостей для better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Копирование package файлов
COPY package*.json ./

# Установка зависимостей
RUN npm ci --only=production

# Копирование исходного кода
COPY . .

# Компиляция TypeScript
RUN npm run build

# Создание директорий для хранения
RUN mkdir -p storage/sessions storage/media storage/database

# Открытие порта
EXPOSE 3000

# Запуск приложения
CMD ["npm", "start"]

