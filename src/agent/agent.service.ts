import { Injectable, Logger } from '@nestjs/common';
import { ChatMemoryService } from './chat-memory.service';
import { TenantQueryService } from './tenant-query.service';
import { AiService } from './ai.service';
import { BotiaService } from './botia.service';

interface IncomingWebhookData {
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
}

const SYSTEM_PROMPT = `Eres *Asistente QIPI* de la asociacion de ahorro y credito del socio.

FORMATO DE RESPUESTA:
- Maximo 3-4 lineas por respuesta. Se breve.
- Usa formato WhatsApp: *negrita*, _cursiva_, ~tachado~
- Usa S/ para moneda
- No uses markdown (##, **, listas con -)
- Para listas usa saltos de linea con bullet • o numeros
- Si hay muchos datos, resume lo mas importante
- No repitas el nombre del socio en cada mensaje

CAPACIDADES (solo lectura):
- Prestamos activos, saldos, cuotas pendientes
- Ahorros/depositos acumulados
- Acciones compradas y valor
- Solicitudes de credito y estado

REGLAS:
- Solo info del socio que escribe (por su telefono)
- NO puedes hacer operaciones (crear prestamos, depositos, etc)
- Si pide algo que no puedes, dile que vaya a la oficina
- Responde en espanol, tono amigable pero conciso
- Si no esta registrado, pide que verifique su numero

CONTEXTO DEL SOCIO:
`;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private chatMemory: ChatMemoryService,
    private tenantQuery: TenantQueryService,
    private ai: AiService,
    private botia: BotiaService,
  ) {}

  async handleIncomingMessage(
    workspaceId: string,
    data: IncomingWebhookData,
  ): Promise<void> {
    const { contact, message, conversation_id, channel_id } = data;
    const phone = contact.phone;

    this.logger.log(`Mensaje de ${contact.name} (${phone}): ${message.content}`);

    if (message.message_type !== 'text' || !message.content?.trim()) {
      return;
    }

    try {
      const summary = await this.tenantQuery.getFullSocioSummary(phone);

      let systemPrompt = SYSTEM_PROMPT;
      if (summary) {
        systemPrompt += this.tenantQuery.buildContextForAI(summary);
      } else {
        systemPrompt += `No se encontro socio con telefono ${phone}. Indica que no esta registrado o que verifique su numero.`;
      }

      const history = this.chatMemory.getHistory(phone);

      this.chatMemory.addMessage(phone, {
        role: 'user',
        content: message.content,
        timestamp: new Date(),
      });

      const aiResponse = await this.ai.chat(
        systemPrompt,
        history,
        message.content,
      );

      this.chatMemory.addMessage(phone, {
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date(),
      });

      const sent = await this.botia.sendMessage({
        conversationId: conversation_id,
        channelId: channel_id,
        contactPhone: phone,
        content: aiResponse,
      });

      if (!sent) {
        this.logger.error(`No se pudo enviar respuesta a Botia para ${phone}`);
      }
    } catch (error) {
      this.logger.error(`Error procesando mensaje de ${phone}: ${error.message}`);

      await this.botia.sendMessage({
        conversationId: conversation_id,
        channelId: channel_id,
        contactPhone: phone,
        content: 'Disculpa, tengo problemas tecnicos. Intenta en unos minutos o contacta a la oficina.',
      });
    }
  }
}
