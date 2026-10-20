import type { EditableLineField, LinePreview, LineValues } from './model.types.js';

export type LineItemProps = {
  line: LineValues;
  index: number;
  preview: LinePreview;
  errors: Partial<Record<EditableLineField, string>>;
  submitted: boolean;
  canEdit: boolean;
  canMutate: boolean;
  lineCount: number;
  onChange: (key: string, field: EditableLineField, value: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onRemove: (key: string) => void;
};
