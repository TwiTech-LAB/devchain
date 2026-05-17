import type { ToolBindingEntry } from './types';
import {
  handleListDocuments,
  handleGetDocument,
  handleCreateDocument,
  handleUpdateDocument,
} from '../services/handlers/document-tools';

export const documentBindings: ToolBindingEntry[] = [
  ['devchain_list_documents', handleListDocuments as unknown as ToolBindingEntry[1]],
  ['devchain_get_document', handleGetDocument as unknown as ToolBindingEntry[1]],
  ['devchain_create_document', handleCreateDocument as unknown as ToolBindingEntry[1]],
  ['devchain_update_document', handleUpdateDocument as unknown as ToolBindingEntry[1]],
];
