import { WhatsAppClient, WhatsAppClientOptions } from './client';
import logger from '../utils/logger';
import { EventEmitter } from 'events';

export interface AccountStatus {
  accountId: string;
  connected: boolean;
  qrCode?: string;
  lastError?: string;
}

export class WhatsAppManager extends EventEmitter {
  private clients: Map<string, WhatsAppClient> = new Map();
  private qrCodes: Map<string, string> = new Map();
  private accountStatuses: Map<string, AccountStatus> = new Map();

  async addAccount(accountId: string, options?: Partial<WhatsAppClientOptions>): Promise<void> {
    if (this.clients.has(accountId)) {
      logger.warn({ accountId }, 'Account already exists');
      return;
    }

    logger.info({ accountId }, 'Adding WhatsApp account');

    const client = new WhatsAppClient({
      accountId,
      onQR: (qr) => {
        this.qrCodes.set(accountId, qr);
        this.updateAccountStatus(accountId, { qrCode: qr });
        this.emit('qr', { accountId, qr });
      },
      onConnected: () => {
        this.qrCodes.delete(accountId);
        this.updateAccountStatus(accountId, { connected: true, qrCode: undefined });
        this.emit('connected', { accountId });
      },
      onDisconnected: (reason) => {
        this.updateAccountStatus(accountId, { connected: false, lastError: reason });
        this.emit('disconnected', { accountId, reason });
      },
      onMessage: (message) => {
        this.emit('message', message);
      },
      ...options,
    });

    this.clients.set(accountId, client);
    this.accountStatuses.set(accountId, {
      accountId,
      connected: false,
    });

    try {
      await client.connect();
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to initialize account');
      this.accountStatuses.set(accountId, {
        accountId,
        connected: false,
        lastError: err instanceof Error ? err.message : 'Unknown error',
      });
      throw err;
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (client) {
      await client.disconnect();
      this.clients.delete(accountId);
      this.qrCodes.delete(accountId);
      this.accountStatuses.delete(accountId);
      logger.info({ accountId }, 'Account removed');
    }
  }

  getAccount(accountId: string): WhatsAppClient | undefined {
    return this.clients.get(accountId);
  }

  getQRCode(accountId: string): string | undefined {
    return this.qrCodes.get(accountId);
  }

  getAccountStatus(accountId: string): AccountStatus | undefined {
    return this.accountStatuses.get(accountId);
  }

  getAllAccountStatuses(): AccountStatus[] {
    return Array.from(this.accountStatuses.values());
  }

  async sendMessage(accountId: string, to: string, message: string, options?: { mediaUrl?: string; mediaType?: string }): Promise<void> {
    const client = this.clients.get(accountId);
    if (!client) {
      throw new Error(`Account ${accountId} not found`);
    }

    if (!client.isConnected()) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    await client.sendMessage(to, message, options);
  }

  async sendTyping(accountId: string, to: string, duration?: number): Promise<void> {
    const client = this.clients.get(accountId);
    if (!client) {
      return;
    }

    await client.sendTyping(to, duration);
  }

  private updateAccountStatus(accountId: string, updates: Partial<AccountStatus>): void {
    const current = this.accountStatuses.get(accountId);
    if (current) {
      this.accountStatuses.set(accountId, { ...current, ...updates });
    }
  }

  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.keys()).map(accountId => 
      this.removeAccount(accountId)
    );
    await Promise.all(promises);
  }
}

