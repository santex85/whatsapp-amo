export interface AmoCRMAuthResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

export interface AmoCRMTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  subdomain: string;
}

export interface AmoCRMChatMessage {
  content: string;
  account_id?: string;
  uniq?: string;
  created_at?: number;
}

export interface AmoCRMSendMessageRequest {
  chat_id: string;
  message: AmoCRMChatMessage;
  source?: {
    external_id?: string;
  };
}

export interface AmoCRMWebhookPayload {
  account_id: string;
  chat_id: string;
  conversation_id?: string; // ID существующей беседы в amoCRM
  message: {
    content: string;
    attachments?: Array<{
      url: string;
      type: string;
    }>;
  };
  source?: {
    external_id?: string;
  };
}

export interface AmoCRMChannel {
  id: number;
  name: string;
  type: string;
  account_id: number;
}

