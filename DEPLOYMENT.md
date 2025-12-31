# Развертывание на сервер

## Обзор

После развертывания приложения на сервер с доменом `alexhosting.ru`, webhook от amoCRM будет приходить на endpoint:
```
POST https://alexhosting.ru/location/{scope_id}
```

Где `{scope_id}` - это значение, полученное при выполнении `/api/amocrm/connect`.

## Предварительные требования

1. Сервер с доменом `alexhosting.ru`
2. Node.js 20+ установлен
3. Redis запущен
4. Nginx настроен для проксирования
5. SSL сертификат настроен (для HTTPS)

## Шаги развертывания

### 1. Подготовка сервера

```bash
# Клонировать репозиторий (или скопировать файлы)
git clone <repository-url>
cd whatsapp-amo

# Установить зависимости
npm install

# Собрать проект
npm run build
```

### 2. Настройка переменных окружения

Создайте файл `.env` на сервере:

```env
# Production Configuration
NODE_ENV=production
PORT=3000
DOMAIN=alexhosting.ru
WEBHOOK_BASE_URL=https://alexhosting.ru

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# Database Configuration
DB_PATH=./storage/database/sessions.db

# amoCRM Configuration
AMOCRM_CLIENT_ID=your_client_id
AMOCRM_CLIENT_SECRET=your_client_secret
AMOCRM_REDIRECT_URI=https://alexhosting.ru/auth/amocrm/callback
AMOCRM_SUBDOMAIN=your_subdomain

# amoCRM Channel Configuration
AMOCRM_CHANNEL_ID=your_channel_id
AMOCRM_CHANNEL_CODE=your_channel_code
AMOCRM_CHANNEL_SECRET=your_channel_secret
AMOCRM_BOT_ID=your_bot_id
AMOCRM_CHANNEL_TITLE=YourChannelName

# amoCRM Amojo Account ID
AMOCRM_AMOJO_ACCOUNT_ID=your_amojo_account_id

# Logging
LOG_LEVEL=info
```

### 3. Настройка Nginx

Создайте конфигурацию Nginx для проксирования на порт 3000:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name alexhosting.ru;

    # Редирект на HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name alexhosting.ru;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 4. Запуск приложения

#### Вариант 1: PM2 (рекомендуется)

```bash
# Установить PM2
npm install -g pm2

# Запустить приложение
pm2 start dist/index.js --name whatsapp-amo

# Сохранить конфигурацию PM2
pm2 save

# Настроить автозапуск
pm2 startup
```

#### Вариант 2: systemd

Создайте файл `/etc/systemd/system/whatsapp-amo.service`:

```ini
[Unit]
Description=WhatsApp-amoCRM Gateway
After=network.target redis.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/whatsapp-amo
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Запустите сервис:

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-amo
sudo systemctl start whatsapp-amo
```

### 5. Выполнение connect для получения scope_id

После запуска приложения выполните:

```bash
curl -X POST https://alexhosting.ru/api/amocrm/connect \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "your_account_id",
    "subdomain": "your_subdomain",
    "amojo_account_id": "your_amojo_account_id"
  }'
```

Сохраните полученный `scope_id` - он понадобится для настройки webhook в amoCRM.

### 6. Настройка webhook в amoCRM

После получения `scope_id`, настройте webhook URL в amoCRM:

```
https://alexhosting.ru/location/{scope_id}
```

Где `{scope_id}` - это значение из ответа `/api/amocrm/connect`.

**Важно:** Webhook URL должен быть настроен в настройках канала в amoCRM. Обычно это делается через:
- Интерфейс amoCRM → Интеграции → Ваш канал → Настройки
- Или через API amoCRM (если доступно)

## Проверка работы

### 1. Проверка health endpoint

```bash
curl https://alexhosting.ru/health
```

Должен вернуть: `{"status":"ok","timestamp":"..."}`

### 2. Проверка webhook endpoint

```bash
curl -X POST https://alexhosting.ru/location/{scope_id} \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "...",
    "chat_id": "79991234567",
    "message": {
      "content": "Test message"
    }
  }'
```

Должен вернуть: `{"status":"ok","account_id":"...","scope_id":"..."}`

### 3. Проверка логов

```bash
# Если используете PM2
pm2 logs whatsapp-amo

# Если используете systemd
sudo journalctl -u whatsapp-amo -f
```

## Архитектура webhook

```
amoCRM → POST /location/{scope_id} → Поиск account_id по scope_id → Очередь → WhatsApp
```

### Поток обработки:

1. **amoCRM отправляет webhook** на `https://alexhosting.ru/location/{scope_id}`
2. **Приложение извлекает scope_id** из URL
3. **Поиск account_id** в БД по `scope_id`
4. **Валидация payload** от amoCRM
5. **Постановка в очередь** для отправки в WhatsApp
6. **Отправка сообщения** в WhatsApp через Baileys

## Мониторинг

### Проверка статуса

```bash
# PM2
pm2 status

# systemd
sudo systemctl status whatsapp-amo
```

### Проверка Redis

```bash
redis-cli ping
```

### Проверка базы данных

```bash
sqlite3 storage/database/sessions.db "SELECT account_id, scope_id FROM amocrm_tokens;"
```

## Обновление приложения

```bash
# Остановить приложение
pm2 stop whatsapp-amo
# или
sudo systemctl stop whatsapp-amo

# Обновить код
git pull
npm install
npm run build

# Запустить приложение
pm2 start whatsapp-amo
# или
sudo systemctl start whatsapp-amo
```

## Устранение неполадок

### Webhook не приходит

1. Проверьте, что endpoint доступен: `curl https://alexhosting.ru/location/{scope_id}`
2. Проверьте логи приложения
3. Проверьте настройки webhook в amoCRM
4. Убедитесь, что `scope_id` правильный и есть в БД

### Сообщения не отправляются в WhatsApp

1. Проверьте, что WhatsApp аккаунт подключен
2. Проверьте логи приложения
3. Проверьте очередь Redis: `redis-cli LLEN outgoing:queue`
4. Убедитесь, что номер телефона правильный

### Ошибка 404 при webhook

1. Проверьте, что `scope_id` правильный
2. Проверьте, что `/api/amocrm/connect` был выполнен
3. Проверьте БД: `sqlite3 storage/database/sessions.db "SELECT scope_id FROM amocrm_tokens;"`

## Безопасность

- Используйте HTTPS для всех запросов
- Храните секретные ключи в `.env` (не коммитьте в git)
- Настройте firewall для ограничения доступа
- Регулярно обновляйте зависимости
- Мониторьте логи на подозрительную активность

## Дополнительная информация

- См. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) для решения проблем
- См. [AMOCRM_CHANNEL_SETUP.md](./AMOCRM_CHANNEL_SETUP.md) для настройки канала
- См. [TROUBLESHOOTING_LOGS.md](./TROUBLESHOOTING_LOGS.md) для работы с логами

