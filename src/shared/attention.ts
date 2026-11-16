export type AttentionScope = 'mine' | 'control';
export type AttentionFilter = 'all' | 'overdue' | 'blocked';
export type AttentionKind = 'REQUEST' | 'TASK' | 'DOCUMENT' | 'DEPARTURE';

export type AttentionItem = {
  id: string;
  sourceId: string;
  kind: AttentionKind;
  scope: AttentionScope;
  title: string;
  subtitle: string;
  locationId: string | null;
  locationName: string;
  timezone: string;
  dueAt: string | null;
  deadlineDay: string | null;
  overdue: boolean;
  blocked: boolean;
  reason: string;
  action: string;
  href: string;
};

export type AttentionPage = {
  items: AttentionItem[];
  counts: { total: number; mine: number; control: number; overdue: number; blocked: number };
  pagination: { page: number; pageSize: number; total: number; pages: number };
};
