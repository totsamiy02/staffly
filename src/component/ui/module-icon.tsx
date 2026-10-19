export default function ModuleIcon({ section }: { section: string }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true } as const
  if (section === 'location') return <svg {...common}><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>
  if (section === '') return <svg {...common}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v10h13V10M9 20v-6h6v6" /></svg>
  if (section === 'employees') return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-2.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V20M15 5.5a3 3 0 0 1 0 5.5M17 13a4 4 0 0 1 3.5 4v3" /></svg>
  if (section === 'schedule') return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3" /></svg>
  if (section === 'requests') return <svg {...common}><path d="M4 4h16v13H8l-4 4V4Z" /><path d="M8 9h8M8 13h5" /></svg>
  if (section === 'events') return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18m5 5 2 2 5-5" /></svg>
  if (section === 'documents') return <svg {...common}><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></svg>
  return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.5v-.1A1.7 1.7 0 0 0 8.4 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-1.5-1H2.4V10h.1A1.7 1.7 0 0 0 4 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 4.2l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1.1-1.5v-.1h4.1v.1A1.7 1.7 0 0 0 15 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
}

