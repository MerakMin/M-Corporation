import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { inspectPageStructure } from './page-structure.js';

// Fixed filenames retain only the latest counter failure for each inbox.
// Never serialize the list reader's rows, URLs, customers or original text.
export async function saveFashionplusPaginationDiagnostic(page, input, snapshot, directory = resolve('diagnostics')) {
  const kind = typeof input === 'object' && input?.kind === 'notification' ? 'notifications' : 'qna';
  const summary = snapshot.paginationDiagnostics || {};
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  try {
    const structure = await inspectPageStructure(page);
    const report = {
      format: 4, channel: 'fashionplus', source: kind === 'qna' ? 'fashionplus-1' : 'fashionplus-0',
      reason: 'list-read-failed',
      pagination: { visibleRows: integer(summary.visibleRows), explicitEmpty: summary.explicitEmpty === true,
        loading: summary.loading === true, scopedGrid: summary.scopedGrid === true,
        counterCandidates: integer(summary.counterCandidates),
        counters: (Array.isArray(summary.counters) ? summary.counters : []).slice(0, 5).map(c => ({ pages: integer(c.pages), total: integer(c.total) })),
      }, structure,
    };
    const name = `fashionplus-${kind}-pagination.json`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), JSON.stringify(report, null, 2), { mode: 0o600 });
    return `diagnostics/${name}`;
  } catch { return null; } // A diagnostic failure must not hide the original error.
}
