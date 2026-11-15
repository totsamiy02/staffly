import type { AttentionFilter, AttentionItem, AttentionPage, AttentionScope } from '../../shared/attention.ts';

function compare(left: AttentionItem, right: AttentionItem) {
  const rank = (item: AttentionItem) => item.blocked ? 0 : item.overdue ? 1 : 2;
  return rank(left) - rank(right)
    || (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999')
    || left.id.localeCompare(right.id);
}

/** Counts every readable action while retaining only the requested page prefix. */
export class AttentionCollector {
  private readonly items: AttentionItem[] = [];
  private total = 0;
  private readonly counts = { total: 0, mine: 0, control: 0, overdue: 0, blocked: 0 };

  private readonly options: { scope: AttentionScope; filter: AttentionFilter; page: number; pageSize: number };
  constructor(options: { scope: AttentionScope; filter: AttentionFilter; page: number; pageSize: number }) { this.options = options; }

  add(item: AttentionItem) {
    this.counts.total++;
    this.counts[item.scope]++;
    if (item.scope !== this.options.scope) return;
    if (item.overdue) this.counts.overdue++;
    if (item.blocked) this.counts.blocked++;
    if (this.options.filter === 'overdue' && !item.overdue || this.options.filter === 'blocked' && !item.blocked) return;
    this.total++;
    let low = 0, high = this.items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (compare(this.items[middle], item) <= 0) low = middle + 1; else high = middle; }
    if (low >= this.options.page * this.options.pageSize) return;
    this.items.splice(low, 0, item);
    if (this.items.length > this.options.page * this.options.pageSize) this.items.pop();
  }

  result(): AttentionPage {
    return {
      items: this.items.slice((this.options.page - 1) * this.options.pageSize),
      counts: this.counts,
      pagination: {
        page: this.options.page,
        pageSize: this.options.pageSize,
        total: this.total,
        pages: Math.max(1, Math.ceil(this.total / this.options.pageSize)),
      },
    };
  }
}
