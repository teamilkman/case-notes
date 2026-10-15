export interface EditorLine { line_id?: string; text: string }
export function editLines(rows: EditorLine[], previous: string, next: string,
  edit: { start: number; end: number; inputType: string }): EditorLine[];
