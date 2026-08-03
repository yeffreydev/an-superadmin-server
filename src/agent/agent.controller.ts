import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { AgentService } from './agent.service';

interface WebhookPayload {
  event: string;
  workspace_id: string;
  timestamp: string;
  data: {
    channel_id: string;
    channel_type: string;
    conversation_id: string;
    contact: {
      id: string;
      name: string;
      phone: string;
    };
    message: {
      content: string;
      message_type: string;
      attachments: any[];
      meta_message_id: string;
      timestamp: string;
    };
  };
}

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(private agentService: AgentService) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() payload: WebhookPayload,
    @Headers('x-webhook-event') event: string,
  ) {
    this.logger.log(`Webhook recibido: ${event || payload.event}`);

    if (!payload.event || !payload.data) {
      throw new BadRequestException('Payload invalido');
    }

    if (payload.event !== 'message.incoming') {
      return { received: true, processed: false, reason: 'evento no soportado' };
    }

    if (!payload.data.contact?.phone || !payload.data.message?.content) {
      return { received: true, processed: false, reason: 'datos incompletos' };
    }

    // Fire-and-forget
    this.agentService
      .handleIncomingMessage(payload.workspace_id, payload.data)
      .catch((err) =>
        this.logger.error(`Error procesando webhook: ${err.message}`),
      );

    return { received: true, processed: true };
  }
}
