export interface QueueMessage {
  id: string;
  type: 'incoming' | 'outgoing';
  accountId: string;
  timestamp: number;
  retryCount?: number;
  data: IncomingMessageData | OutgoingMessageData;
}

export interface IncomingMessageData {
  from: string;
  phoneNumber: string;
  pushName: string | null;
  message: string | null;
  mediaType?: string;
  mediaUrl?: string;
  mediaMimetype?: string;
  timestamp: number;
  originalMessageKey?: string; // Ключ для получения оригинального сообщения
}

export interface OutgoingMessageData {
  to: string;
  message: string;
  mediaUrl?: string;
  mediaType?: string;
}

