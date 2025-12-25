import dotenv from 'dotenv';

dotenv.config();

export const amocrmConfig = {
  clientId: process.env.AMOCRM_CLIENT_ID || '',
  clientSecret: process.env.AMOCRM_CLIENT_SECRET || '',
  redirectUri: process.env.AMOCRM_REDIRECT_URI || 'http://localhost:3000/auth/amocrm/callback',
  subdomain: process.env.AMOCRM_SUBDOMAIN || '',
  scopeId: process.env.AMOCRM_SCOPE_ID || '', // amojo scoped integration id
  channelId: process.env.AMOCRM_CHANNEL_ID || '', // ID канала (из регистрации)
  channelCode: process.env.AMOCRM_CHANNEL_CODE || '', // origin_code (символьный код канала)
  channelSecret: process.env.AMOCRM_CHANNEL_SECRET || '', // secret_key (секретный ключ канала)
  botId: process.env.AMOCRM_BOT_ID || '', // ID бота интеграции
  amojoAccountId: process.env.AMOCRM_AMOJO_ACCOUNT_ID || '', // AMOCRM.constant('account').amojo_id
  channelTitle: process.env.AMOCRM_CHANNEL_TITLE || 'WhatsApp Gateway',
  baseUrl: (subdomain: string) => `https://${subdomain}.amocrm.ru`,
  apiUrl: (subdomain: string) => `https://${subdomain}.amocrm.ru/api/v4`,
  oauthUrl: (subdomain: string) => `https://${subdomain}.amocrm.ru/oauth2/access_token`,
  // Авторизация должна идти через общий домен amoCRM, а не через поддомен аккаунта
  authorizeUrl: () => `https://www.amocrm.ru/oauth`,
};

