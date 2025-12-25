export class GatewayError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class WhatsAppError extends GatewayError {
  constructor(message: string, code: string = 'WHATSAPP_ERROR') {
    super(message, code);
    this.name = 'WhatsAppError';
  }
}

export class AmoCRMError extends GatewayError {
  constructor(message: string, code: string = 'AMOCRM_ERROR', statusCode: number = 500) {
    super(message, code, statusCode);
    this.name = 'AmoCRMError';
  }
}

export class QueueError extends GatewayError {
  constructor(message: string, code: string = 'QUEUE_ERROR') {
    super(message, code);
    this.name = 'QueueError';
  }
}

