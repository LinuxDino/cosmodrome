import { width } from '../screen.js';

/** Suggestion list under the input (slash commands, channels, agents...). */
export function menu({ items, index, t, maxItems = 8 }) {
  const MAX_ITEMS = Math.max(1, maxItems);
  let start = 0;
  if (items.length > MAX_ITEMS) start = Math.min(Math.max(0, index - MAX_ITEMS + 1), items.length - MAX_ITEMS);
  const view = items.slice(start, start + MAX_ITEMS);
  const labelW = Math.min(26, Math.max(...view.map((i) => width(i.label))));
  const lines = view.map((item, i) => {
    const selected = start + i === index;
    const label = item.label + ' '.repeat(Math.max(0, labelW - width(item.label)));
    const hint = item.hint || '';
    return selected ? `  ${t.magenta('❯')} ${t.magenta(t.bold(label))}  ${t.magenta(hint)}` : `    ${label}  ${t.dim(hint)}`;
  });
  if (items.length > MAX_ITEMS) lines.push(t.dim(`    ${index + 1}/${items.length} · ↑↓ to move · tab to complete`));
  return lines;
}
