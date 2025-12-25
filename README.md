# WhatsApp-amoCRM Gateway

Gateway-сервис для двусторонней интеграции между WhatsApp (через Baileys) и amoCRM с поддержкой нескольких аккаунтов, очередей сообщений, обработки медиафайлов и anti-ban механизмов.

⚠️ **Важное предупреждение**: "Серые" интеграции (через эмуляцию веб-версии) нарушают условия использования WhatsApp. Существует высокий риск блокировки номера. Используйте этот метод только для номеров, которые не жалко потерять, или строго соблюдайте лимиты рассылок. Для критически важных бизнес-процессов рекомендуется WhatsApp Business API (WABA).

## Возможности

- ✅ Поддержка нескольких WhatsApp аккаунтов одновременно
- ✅ Двусторонний обмен сообщениями (WhatsApp ↔ amoCRM)
- ✅ Обработка медиафайлов (изображения, видео, аудио, документы)
- ✅ OAuth2 авторизация в amoCRM
- ✅ Очередь сообщений на Redis
- ✅ Anti-ban механизмы (задержки, симуляция печати, rate limiting)
- ✅ Веб-интерфейс для QR-кода авторизации
- ✅ Сохранение сессий в SQLite
- ✅ Docker поддержка

## Требования

- Node.js 20+ (рекомендуется 20 LTS или 22+)
- Redis
- SQLite (встроен в better-sqlite3)
- Аккаунт amoCRM с настроенной интеграцией
- Build tools для компиляции native модулей (Xcode Command Line Tools на macOS)

**Примечание:** Если у вас Node.js 25+, убедитесь, что установлены последние версии зависимостей. При проблемах с компиляцией см. [INSTALLATION.md](./INSTALLATION.md)

## Быстрый старт

```bash
# 1. Установите зависимости
npm install

# Если возникла ошибка "C++20 or later required":
npm run fix:install

# 2. Запустите Redis
npm run redis:start

# 3. Настройте .env файл
cp .env.example .env
# Отредактируйте .env и добавьте ваши данные amoCRM

# 4. Запустите приложение
npm run dev

# 5. Откройте в браузере для добавления WhatsApp аккаунта
# http://localhost:3000/qr/your-account-id
```

## Установка

### Локальная установка

1. Клонируйте репозиторий:
```bash
git clone <repository-url>
cd whatsapp-amo
```

2. Установите зависимости:
```bash
npm install
```

**Если возникли проблемы с компиляцией `better-sqlite3` (ошибка "C++20 or later required"):**

Быстрое решение:
```bash
npm run fix:install
```

Или вручную:
```bash
# Очистите и переустановите
rm -rf node_modules package-lock.json
npm cache clean --force
npm install

# Или пересоберите модуль
npm rebuild better-sqlite3
```

**Альтернативы:**
- Используйте Node.js 20 LTS вместо 25 (рекомендуется)
- Или используйте Docker (см. ниже)

Подробнее см. [QUICK_FIX.md](./QUICK_FIX.md) и [INSTALLATION.md](./INSTALLATION.md)

3. **Запустите Redis** (обязательно!):
```bash
# macOS (через Homebrew)
brew services start redis

# Или используйте скрипт
npm run redis:start

# Проверьте, что Redis работает
npm run redis:check
# Должно вернуть: PONG
```

Если Redis не установлен:
```bash
# macOS
brew install redis

# Linux
sudo apt-get install redis-server
```

Подробнее см. [REDIS_SETUP.md](./REDIS_SETUP.md)

4. Скопируйте `.env.example` в `.env` и заполните настройки:
```bash
cp .env.example .env
```

4. Настройте переменные окружения в `.env`:
```env
# Server
PORT=3000
NODE_ENV=development

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# SQLite
DB_PATH=./storage/database/sessions.db

# amoCRM
AMOCRM_CLIENT_ID=your_client_id
AMOCRM_CLIENT_SECRET=your_client_secret
AMOCRM_REDIRECT_URI=http://localhost:3000/auth/amocrm/callback
AMOCRM_SUBDOMAIN=your_subdomain

# Media
MEDIA_STORAGE_PATH=./storage/media
MEDIA_CLEANUP_INTERVAL=3600000

# Anti-Ban
MIN_DELAY_MS=2000
MAX_DELAY_MS=10000
TYPING_DURATION_MS=1500
```

5. Соберите проект:
```bash
npm run build
```

6. Запустите приложение:
```bash
npm start
```

Для разработки с автоперезагрузкой:
```bash
npm run dev
```

Или с автоматическим запуском Redis:
```bash
npm run dev:with-redis
```

### Docker установка

1. Скопируйте `.env.example` в `.env` и заполните настройки

2. Запустите через Docker Compose:
```bash
docker-compose -f docker/docker-compose.yml up -d
```

## Настройка amoCRM

1. Создайте интеграцию в amoCRM:
   - Перейдите в настройки → Интеграции
   - Создайте новую интеграцию
   - Получите `client_id` и `client_secret`
   - Укажите `redirect_uri`: `http://your-domain:3000/auth/amocrm/callback`

2. Авторизуйтесь:
   - Откройте в браузере: `http://your-domain:3000/auth/amocrm?account_id=YOUR_ACCOUNT_ID&subdomain=YOUR_SUBDOMAIN`
   - Разрешите доступ
   - Токены сохранятся автоматически

3. Настройте канал в amoCRM:
   - Создайте канал в разделе Чаты
   - Укажите Webhook URL: `http://your-domain:3000/api/webhook/amocrm`

## Использование

### Добавление WhatsApp аккаунта

1. Откройте в браузере: `http://localhost:3000/qr/YOUR_ACCOUNT_ID`
   - Замените `YOUR_ACCOUNT_ID` на уникальный идентификатор аккаунта

2. Отсканируйте QR-код через WhatsApp:
   - Откройте WhatsApp на телефоне
   - Меню → Связанные устройства → Связать устройство
   - Отсканируйте QR-код

3. После успешного подключения аккаунт будет автоматически обрабатывать сообщения

### API Endpoints

- `GET /` - Информация о сервисе
- `GET /health` - Проверка здоровья сервиса
- `GET /api/accounts` - Список всех аккаунтов
- `GET /api/accounts/:accountId` - Статус конкретного аккаунта
- `POST /api/accounts/:accountId` - Добавить новый аккаунт
- `DELETE /api/accounts/:accountId` - Удалить аккаунт
- `GET /api/qr/:accountId` - QR-код для авторизации (изображение)
- `GET /api/qr/:accountId/data` - QR-код для авторизации (JSON)
- `GET /qr/:accountId` - Веб-страница с QR-кодом
- `POST /api/webhook/amocrm` - Webhook для приема сообщений от amoCRM

### Потоки данных

#### Входящее сообщение (WhatsApp → amoCRM)

1. Пользователь отправляет сообщение в WhatsApp
2. Сервис получает сообщение через Baileys
3. Сообщение ставится в очередь Redis
4. Применяются anti-ban задержки
5. Сообщение отправляется в amoCRM через Chats API
6. amoCRM создает/обновляет контакт и сделку

#### Исходящее сообщение (amoCRM → WhatsApp)

1. Менеджер отвечает в amoCRM
2. amoCRM отправляет webhook на `/api/webhook/amocrm`
3. Сообщение ставится в очередь Redis
4. Применяются anti-ban механизмы:
   - Симуляция печати (1-2 сек)
   - Случайная задержка (2-10 сек)
   - Rate limiting проверка
5. Сообщение отправляется в WhatsApp через Baileys

## Архитектура

```
WhatsApp → Baileys Client → Queue (Redis) → Anti-Ban → amoCRM API
amoCRM → Webhook → Queue (Redis) → Anti-Ban → Baileys Client → WhatsApp
```

### Компоненты

- **WhatsApp Manager** - Управление несколькими WhatsApp аккаунтами
- **Queue Processor** - Обработка очередей сообщений
- **AmoCRM API** - Интеграция с amoCRM Chats API
- **Media Handler** - Обработка медиафайлов
- **Anti-Ban Service** - Защита от блокировки
- **Web Server** - Веб-интерфейс и API

## Anti-Ban механизмы

Для снижения риска блокировки реализованы следующие механизмы:

1. **Случайные задержки**: 2-10 секунд перед отправкой сообщения
2. **Симуляция печати**: Отправка статуса "печатает" перед сообщением
3. **Rate Limiting**: Ограничение количества сообщений (10/мин для текста, 5/мин для медиа)
4. **Очередь сообщений**: Последовательная обработка, не пачками

## Безопасность

- Валидация webhook запросов от amoCRM
- Изоляция сессий между аккаунтами
- Автоматическая очистка временных медиафайлов
- Логирование всех операций

## Разработка

### Структура проекта

```
whatsapp-amo/
├── src/
│   ├── config/          # Конфигурация
│   ├── whatsapp/        # WhatsApp клиент (Baileys)
│   ├── amocrm/          # amoCRM интеграция
│   ├── queue/           # Очередь сообщений (Redis)
│   ├── media/           # Обработка медиафайлов
│   ├── anti-ban/        # Anti-ban механизмы
│   ├── web/             # Веб-интерфейс
│   ├── database/        # SQLite хранилище
│   └── utils/           # Утилиты
├── storage/             # Хранилище (сессии, медиа, БД)
├── docker/              # Docker конфигурация
└── dist/                # Скомпилированный код
```

### Запуск в режиме разработки

```bash
npm run dev
```

### Сборка

```bash
npm run build
```

## Тестирование

Для подробного руководства по тестированию всех компонентов см. [TESTING.md](./TESTING.md)

### Быстрый тест

После запуска приложения выполните:

```bash
npm run test:basic
```

Или вручную:

```bash
./test-script.sh
```

Это проверит:
- Здоровье сервиса
- API endpoints
- Добавление аккаунтов
- Генерацию QR-кода
- Webhook endpoint

## Решение проблем

Подробное руководство по решению проблем см. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

### Проблема с компиляцией better-sqlite3

Если при установке возникает ошибка **"C++20 or later required"**, см. [QUICK_FIX.md](./QUICK_FIX.md) для быстрого решения.

**Кратко:**
```bash
npm run fix:install
```

Или используйте Node.js 20 LTS вместо 25.

### QR-код не появляется

- Проверьте, что аккаунт добавлен: `POST /api/accounts/:accountId`
- Проверьте логи на наличие ошибок
- Убедитесь, что директория `storage/sessions` существует и доступна для записи

### Сообщения не отправляются в amoCRM

- Проверьте настройки amoCRM (client_id, client_secret, subdomain)
- Убедитесь, что токены получены и не истекли
- Проверьте логи на наличие ошибок API

### Сообщения не отправляются в WhatsApp

- Проверьте, что аккаунт подключен (статус `connected: true`)
- Проверьте rate limiting (может быть превышен лимит)
- Проверьте логи на наличие ошибок

### Redis connection error

**Ошибка:** `Could not connect to Redis at 127.0.0.1:6379: Connection refused`

**Решение:**
1. Запустите Redis:
   ```bash
   npm run redis:start
   # или
   brew services start redis
   ```

2. Проверьте подключение:
   ```bash
   npm run redis:check
   ```

3. Если Redis не установлен, установите его:
   ```bash
   brew install redis  # macOS
   sudo apt-get install redis-server  # Linux
   ```

4. Подробные инструкции см. [INSTALLATION.md](./INSTALLATION.md)

## Лицензия

MIT

## Документация

- [TESTING.md](./TESTING.md) - Руководство по тестированию
- [INSTALLATION.md](./INSTALLATION.md) - Подробная установка
- [QUICK_FIX.md](./QUICK_FIX.md) - Быстрое решение проблем
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Решение проблем

## Поддержка

При возникновении проблем:

1. Проверьте [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
2. Проверьте [QUICK_FIX.md](./QUICK_FIX.md) для быстрых решений
3. Создайте issue в репозитории с подробным описанием проблемы

