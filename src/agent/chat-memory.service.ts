import { Injectable } from '@nestjs/common';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

@Injectable()
export class ChatMemoryService {
  private readonly MAX_MESSAGES = 20;
  private conversations: Map<string, ChatMessage[]> = new Map();

  getHistory(phone: string): ChatMessage[] {
    return this.conversations.get(phone) || [];
  }

  addMessage(phone: string, message: ChatMessage): void {
    const history = this.conversations.get(phone) || [];
    history.push(message);

    if (history.length > this.MAX_MESSAGES) {
      history.splice(0, history.length - this.MAX_MESSAGES);
    }

    this.conversations.set(phone, history);
  }

  clearHistory(phone: string): void {
    this.conversations.delete(phone);
  }
}
