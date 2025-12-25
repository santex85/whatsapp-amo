#!/bin/bash

# Скрипт для автоматического тестирования основных компонентов

BASE_URL="http://localhost:3000"
ACCOUNT_ID="test-account-$(date +%s)"

echo "🧪 Начинаем тестирование WhatsApp-amoCRM Gateway"
echo "=================================================="
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для проверки ответа
check_response() {
    local name=$1
    local response=$2
    local expected_status=$3
    
    if echo "$response" | grep -q "$expected_status" || [ "$expected_status" = "any" ]; then
        echo -e "${GREEN}✓${NC} $name - OK"
        return 0
    else
        echo -e "${RED}✗${NC} $name - FAILED"
        echo "Response: $response"
        return 1
    fi
}

# 1. Проверка здоровья сервиса
echo "1. Проверка здоровья сервиса..."
HEALTH_RESPONSE=$(curl -s "$BASE_URL/health")
check_response "Health check" "$HEALTH_RESPONSE" "ok"
echo ""

# 2. Проверка информации о сервисе
echo "2. Проверка информации о сервисе..."
INFO_RESPONSE=$(curl -s "$BASE_URL/")
check_response "Service info" "$INFO_RESPONSE" "WhatsApp-amoCRM Gateway"
echo ""

# 3. Добавление аккаунта
echo "3. Добавление WhatsApp аккаунта..."
ADD_RESPONSE=$(curl -s -X POST "$BASE_URL/api/accounts/$ACCOUNT_ID")
check_response "Add account" "$ADD_RESPONSE" "Account added successfully"
echo ""

# 4. Проверка статуса аккаунта
echo "4. Проверка статуса аккаунта..."
STATUS_RESPONSE=$(curl -s "$BASE_URL/api/accounts/$ACCOUNT_ID")
check_response "Account status" "$STATUS_RESPONSE" "$ACCOUNT_ID"
echo ""

# 5. Проверка QR-кода
echo "5. Проверка QR-кода..."
QR_RESPONSE=$(curl -s "$BASE_URL/api/qr/$ACCOUNT_ID/data")
if echo "$QR_RESPONSE" | grep -q "qr"; then
    echo -e "${GREEN}✓${NC} QR code - OK"
else
    echo -e "${YELLOW}⚠${NC} QR code - Not available (account may be connected)"
fi
echo ""

# 6. Проверка списка аккаунтов
echo "6. Проверка списка аккаунтов..."
ACCOUNTS_RESPONSE=$(curl -s "$BASE_URL/api/accounts")
check_response "List accounts" "$ACCOUNTS_RESPONSE" "accounts"
echo ""

# 7. Тест webhook (без реальной отправки)
echo "7. Тест webhook endpoint..."
WEBHOOK_RESPONSE=$(curl -s -X POST "$BASE_URL/api/webhook/amocrm" \
  -H "Content-Type: application/json" \
  -d "{
    \"account_id\": \"$ACCOUNT_ID\",
    \"chat_id\": \"79991234567\",
    \"message\": {
      \"content\": \"Test message\"
    }
  }")
check_response "Webhook" "$WEBHOOK_RESPONSE" "ok"
echo ""

# 8. Проверка Redis (если доступен)
echo "8. Проверка Redis..."
if command -v redis-cli &> /dev/null; then
    if redis-cli ping &> /dev/null; then
        echo -e "${GREEN}✓${NC} Redis - Connected"
    else
        echo -e "${RED}✗${NC} Redis - Not connected"
    fi
else
    echo -e "${YELLOW}⚠${NC} Redis CLI not found, skipping check"
fi
echo ""

# 9. Проверка базы данных
echo "9. Проверка базы данных..."
if [ -f "storage/database/sessions.db" ]; then
    echo -e "${GREEN}✓${NC} Database file exists"
else
    echo -e "${YELLOW}⚠${NC} Database file not found (will be created on first run)"
fi
echo ""

# Итоги
echo "=================================================="
echo "✅ Базовое тестирование завершено"
echo ""
echo "📋 Следующие шаги:"
echo "1. Откройте в браузере: $BASE_URL/qr/$ACCOUNT_ID"
echo "2. Отсканируйте QR-код через WhatsApp"
echo "3. Проверьте статус: curl $BASE_URL/api/accounts/$ACCOUNT_ID"
echo "4. Отправьте тестовое сообщение в WhatsApp"
echo ""
echo "Для подробного тестирования см. TESTING.md"

