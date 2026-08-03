import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ChatMemoryService } from './chat-memory.service';
import { TenantQueryService } from './tenant-query.service';
import { AiService } from './ai.service';
import { BotiaService } from './botia.service';

@Module({
  controllers: [AgentController],
  providers: [
    AgentService,
    ChatMemoryService,
    TenantQueryService,
    AiService,
    BotiaService,
  ],
})
export class AgentModule {}
