import type { ToolBindingEntry } from './types';
import {
  handleSendMessage,
  handleChatAck,
  handleChatListMembers,
  handleChatReadHistory,
} from '../services/handlers/chat-tools';

export const chatBindings: ToolBindingEntry[] = [
  ['devchain_send_message', handleSendMessage as unknown as ToolBindingEntry[1]],
  ['devchain_chat_ack', handleChatAck as unknown as ToolBindingEntry[1]],
  ['devchain_chat_read_history', handleChatReadHistory as unknown as ToolBindingEntry[1]],
  ['devchain_chat_list_members', handleChatListMembers as unknown as ToolBindingEntry[1]],
];
