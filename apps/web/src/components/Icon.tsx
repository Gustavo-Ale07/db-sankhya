// Small generic line icons drawn for this app (16×16 grid, stroke = currentColor).

export type IconName =
  | 'play'
  | 'stop'
  | 'plus'
  | 'save'
  | 'folder'
  | 'sidebar'
  | 'table'
  | 'column'
  | 'key'
  | 'link'
  | 'chevron-right'
  | 'chevron-down'
  | 'close'
  | 'search'
  | 'refresh';

const PATHS: Record<IconName, string> = {
  play: 'M5 3.5v9l7-4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  plus: 'M8 3.5v9M3.5 8h9',
  save: 'M3.5 2.5h7l2 2v9h-9zM5.5 2.5v3h4v-3M5.5 13.5v-4h5v4',
  folder: 'M2 4.5h4.5l1.5 1.5h6v7.5h-12z',
  sidebar: 'M2.5 3h11v10h-11zM6 3v10',
  table: 'M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.75h11M6.5 6.5V13',
  column: 'M5 2.5h6v11H5zM5 6h6',
  key: 'M6 10a3 3 0 1 1 0-.01M8.5 8.5l5-5M11.5 5.5l1.5 1.5',
  link: 'M6.5 9.5l3-3M5 8l-1.5 1.5a2.1 2.1 0 0 0 3 3L8 11M8 5l1.5-1.5a2.1 2.1 0 0 1 3 3L11 8',
  'chevron-right': 'M6 4l4 4-4 4',
  'chevron-down': 'M4 6l4 4 4-4',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  search: 'M7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10.25 10.25l3.25 3.25',
  refresh: 'M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3',
};

const FILLED: ReadonlySet<IconName> = new Set(['play', 'stop']);

/** Decorative: the control that holds it carries the accessible name. */
export function Icon({
  name,
  size = 14,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const filled = FILLED.has(name);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ''}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
