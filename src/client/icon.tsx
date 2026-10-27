// Decorative Fluent UI System Icons from the supplied canvas sources.
const paths = {
  info: 'M8.5 7.5a.5.5 0 1 0-1 0v3a.5.5 0 0 0 1 0zm.25-2a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1M2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8',
  warning:
    'M5.82 2.28a2.5 2.5 0 0 1 4.36 0l4.5 8A2.5 2.5 0 0 1 12.5 14h-9a2.5 2.5 0 0 1-2.18-3.72zm3.49.48a1.5 1.5 0 0 0-2.62 0l-4.5 8a1.5 1.5 0 0 0 1.31 2.24h9a1.5 1.5 0 0 0 1.3-2.23zM8 9.5A.75.75 0 1 1 8 11a.75.75 0 0 1 0-1.5M8 5c.28 0 .5.22.5.5V8a.5.5 0 0 1-1 0V5.5c0-.28.22-.5.5-.5',
  check:
    'M2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8m6-7a7 7 0 1 0 0 14A7 7 0 0 0 8 1m2.85 5.85a.5.5 0 0 0-.7-.7l-2.9 2.9-1.4-1.4a.5.5 0 1 0-.7.7L6.9 10.1c.2.2.5.2.7 0z',
} as const;

export function Icon({ name, className = '' }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
