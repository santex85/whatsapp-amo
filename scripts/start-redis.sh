#!/bin/bash

# Скрипт для запуска Redis

if command -v brew &> /dev/null; then
    # macOS через Homebrew
    if brew services list | grep -q "redis.*started"; then
        echo "Redis уже запущен через Homebrew"
    else
        echo "Запуск Redis через Homebrew..."
        brew services start redis
    fi
elif command -v redis-server &> /dev/null; then
    # Проверяем, не запущен ли уже Redis
    if redis-cli ping &> /dev/null; then
        echo "Redis уже запущен"
    else
        echo "Запуск Redis вручную..."
        redis-server --daemonize yes
    fi
else
    echo "Redis не найден. Установите его:"
    echo "  macOS: brew install redis"
    echo "  Linux: sudo apt-get install redis-server"
    exit 1
fi

# Проверяем подключение
sleep 1
if redis-cli ping &> /dev/null; then
    echo "✓ Redis успешно запущен"
else
    echo "✗ Не удалось подключиться к Redis"
    exit 1
fi
