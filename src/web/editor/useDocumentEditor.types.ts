import type { User } from '../../shared/types/api-contracts.js';

export type DocumentEditorProps = {
  owner: User;
  documentId?: string;
  onAuthExpired: () => void;
};
