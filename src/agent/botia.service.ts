import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { appConfig } from '../config';

interface SendMessagePayload {
  conversationId: string;
  channelId: string;
  contactPhone: string;
  content: string;
}

@Injectable()
export class BotiaService {
  private readonly logger = new Logger(BotiaService.name);

  async sendMessage(payload: SendMessagePayload): Promise<boolean> {
    const webhookUrl = appConfig.BOTIA_WEBHOOK_URL;
    const apiKey = appConfig.BOTIA_API_KEY;

    if (!webhookUrl || !apiKey) {
      this.logger.error('BOTIA_WEBHOOK_URL o BOTIA_API_KEY no estan configurados');
      return false;
    }

    try {
      const response = await axios.post(
        webhookUrl,
        {
          conversation_id: payload.conversationId,
          channel_id: payload.channelId,
          contact_phone: payload.contactPhone,
          content: payload.content,
          source: 'ai_agent',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
          },
          timeout: 10000,
        },
      );

      if (response.status >= 200 && response.status < 300) {
        this.logger.log(`Mensaje enviado a Botia para ${payload.contactPhone}`);
        return true;
      }

      this.logger.warn(`Botia respondio con status ${response.status}`);
      return false;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Error enviando a Botia: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`,
        );
      } else {
        this.logger.error(`Error enviando a Botia: ${error.message}`);
      }
      return false;
    }
  }
}
