import pino from 'pino';

// Убеждаемся, что логи всегда выводятся в консоль
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
      singleLine: false,
      hideObject: false,
    },
  },
});

export default logger;

