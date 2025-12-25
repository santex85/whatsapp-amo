import { ConnectionState, DisconnectReason } from '@whiskeysockets/baileys';
import logger from '../../utils/logger';
import { Boom } from '@hapi/boom';

export interface ConnectionHandlerCallbacks {
  onQR?: (qr: string) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onConnecting?: () => void;
}

export function setupConnectionHandler(
  sock: any,
  accountId: string,
  callbacks: ConnectionHandlerCallbacks = {}
) {
  sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info({ accountId }, 'QR code received');
      if (callbacks.onQR) {
        callbacks.onQR(qr);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      
      logger.warn(
        { 
          accountId, 
          statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode,
          shouldReconnect 
        },
        'Connection closed'
      );

      if (callbacks.onDisconnected) {
        callbacks.onDisconnected(
          (lastDisconnect?.error as Boom)?.output?.statusCode?.toString() || 'unknown'
        );
      }

      if (shouldReconnect) {
        logger.info({ accountId }, 'Reconnecting...');
        if (callbacks.onConnecting) {
          callbacks.onConnecting();
        }
      } else {
        logger.error({ accountId }, 'Logged out, manual reconnection required');
      }
    } else if (connection === 'open') {
      logger.info({ accountId }, 'Connected to WhatsApp');
      if (callbacks.onConnected) {
        callbacks.onConnected();
      }
    } else if (connection === 'connecting') {
      logger.info({ accountId }, 'Connecting to WhatsApp...');
      if (callbacks.onConnecting) {
        callbacks.onConnecting();
      }
    }
  });

  sock.ev.on('creds.update', () => {
    logger.debug({ accountId }, 'Credentials updated');
  });
}

