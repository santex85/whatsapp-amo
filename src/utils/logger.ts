import pino from 'pino';

// Настройка уровня логирования: в production только важные логи (warn и выше)
// Для отладки можно установить LOG_LEVEL=info или LOG_LEVEL=debug
const defaultLogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'info';

const logger = pino({
  level: process.env.LOG_LEVEL || defaultLogLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
      singleLine: false,
      hideObject: false,
      // Показываем только важные логи в production
      levelFirst: true,
    },
  },
});

export default logger;

