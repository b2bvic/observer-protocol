import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

export function validateId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error('Identifier must contain only letters, digits, underscores, or hyphens');
  }
  return id;
}

export function readDraft(filepath: string) {
  const parsed = matter(fs.readFileSync(filepath, 'utf-8'));
  // Legacy double-colon fields parse as keys with a trailing colon in YAML.
  const data = { ...parsed.data };
  for (const key of Object.keys(data)) {
    if (key.endsWith(':')) {
      data[key.slice(0, -1)] = data[key];
      delete data[key];
    }
  }
  return { data, content: parsed.content };
}

export function setDraftStatus(vaultPath: string, id: string, status: 'approved' | 'rejected', reason?: string): void {
  const filepath = path.join(vaultPath, '.observer', 'drafts', `${validateId(id)}.md`);
  const draft = readDraft(filepath);
  if (draft.data.status !== 'pending') {
    throw new Error('Draft must be pending before review');
  }
  draft.data.status = status;
  if (status === 'approved') draft.data.approved_at = new Date().toISOString();
  if (reason) draft.data.rejection_reason = reason;
  fs.writeFileSync(filepath, matter.stringify(draft.content, draft.data));
}
