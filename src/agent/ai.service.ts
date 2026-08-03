import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { appConfig } from '../config';
import { ChatMessage } from './chat-memory.service';

interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  async chat(
    systemPrompt: string,
    history: ChatMessage[],
    userMessage: string,
  ): Promise<string> {
    const apiKey = appConfig.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY no esta configurado');
    }

    const messages: AiMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of history) {
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    messages.push({ role: 'user', content: userMessage });

    try {
      const response = await axios.post(
        `${appConfig.DEEPSEEK_BASE_URL}/v1/chat/completions`,
        {
          model: appConfig.DEEPSEEK_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 512,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const reply = response.data.choices?.[0]?.message?.content;
      if (!reply) {
        throw new Error('La IA no devolvio una respuesta valida');
      }

      this.logger.log(`AI tokens: ${response.data.usage?.total_tokens ?? 'N/A'}`);
      return reply;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `AI API error: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`,
        );
      } else {
        this.logger.error(`AI error: ${error.message}`);
      }
      throw error;
    }
  }
}
