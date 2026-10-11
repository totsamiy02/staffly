/** Decorative guide cover; abstract book and cards, never an imitation of a Staffly screen. */
export default function GuideArtwork() {
  return <svg className="guide-artwork" viewBox="0 0 560 440" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="guide-book-cover" x1="130" y1="110" x2="420" y2="380" gradientUnits="userSpaceOnUse"><stop stopColor="#5F9BFF" /><stop offset=".45" stopColor="#2466DF" /><stop offset="1" stopColor="#123A8B" /></linearGradient>
      <linearGradient id="guide-book-page" x1="170" y1="190" x2="365" y2="340" gradientUnits="userSpaceOnUse"><stop stopColor="#ECF4FF" /><stop offset="1" stopColor="#91BBFF" /></linearGradient>
      <linearGradient id="guide-glass" x1="300" y1="50" x2="460" y2="230" gradientUnits="userSpaceOnUse"><stop stopColor="#81AFFF" stopOpacity=".9" /><stop offset="1" stopColor="#1E58C4" stopOpacity=".65" /></linearGradient>
      <linearGradient id="guide-edge" x1="100" y1="100" x2="450" y2="340" gradientUnits="userSpaceOnUse"><stop stopColor="#D5E7FF" /><stop offset="1" stopColor="#326BC5" stopOpacity=".3" /></linearGradient>
      <radialGradient id="guide-glow"><stop stopColor="#2070FF" stopOpacity=".4" /><stop offset="1" stopColor="#2070FF" stopOpacity="0" /></radialGradient>
      <filter id="guide-shadow" x="-40%" y="-40%" width="180%" height="200%"><feDropShadow dx="0" dy="18" stdDeviation="18" floodColor="#020C23" floodOpacity=".45" /></filter>
    </defs>
    <ellipse cx="290" cy="250" rx="260" ry="190" fill="url(#guide-glow)" />
    <g opacity=".3" stroke="#4489FF"><ellipse cx="300" cy="295" rx="230" ry="104" transform="rotate(-12 300 295)" /><ellipse cx="300" cy="295" rx="180" ry="72" transform="rotate(-12 300 295)" /></g>
    <g transform="rotate(-12 365 143)" filter="url(#guide-shadow)"><rect x="278" y="59" width="190" height="155" rx="20" fill="url(#guide-glass)" stroke="url(#guide-edge)" strokeWidth="1.5" /><path d="M278 98h190" stroke="#A2C5FF" strokeOpacity=".35" /><circle cx="298" cy="79" r="4" fill="#B5D3FF" /><circle cx="312" cy="79" r="4" fill="#B5D3FF" fillOpacity=".65" /><circle cx="326" cy="79" r="4" fill="#B5D3FF" fillOpacity=".4" /><rect x="299" y="117" width="42" height="45" rx="9" fill="#80ACFF" fillOpacity=".5" /><path d="m309 140 8 8 15-19" stroke="#D6E8FF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /><path d="M357 124h84m-84 16h68m-68 16h48" stroke="#C1DBFF" strokeWidth="5" strokeOpacity=".6" strokeLinecap="round" /></g>
    <g filter="url(#guide-shadow)">
      <path d="m114 212 157-32 167 66-20 123-151 37-156-73Z" fill="#102F70" stroke="#4779CF" strokeWidth="1.5" />
      <path d="m119 206 152-34 172 63-19 121-154 39-157-69Z" fill="url(#guide-book-cover)" stroke="url(#guide-edge)" strokeWidth="2" />
      <path d="m132 208 129-29 14 20 26-13 126 48-18 103-131 34-146-59Z" fill="url(#guide-book-page)" stroke="#D3E4FF" strokeWidth="1.5" />
      <path d="m261 179 14 20 3 172m23-185-26 13" stroke="#5990EB" strokeWidth="2" />
      <path d="m153 229 85-17m-85 33 86-16m-85 32 87-15m-87 31 69-11m-68 27 50-8m96-67 80 30m-81-13 78 29m-77-11 74 27m-73-9 57 21" stroke="#6298EC" strokeOpacity=".7" strokeWidth="5" strokeLinecap="round" />
      <path d="m275 198 3 173 19-5-4-172Z" fill="#4D87E2" fillOpacity=".28" />
      <path d="m349 202 14 6-12 66-8-11-12 4Z" fill="#0A62FF" />
    </g>
    <g transform="rotate(-12 136 155)" filter="url(#guide-shadow)"><rect x="89" y="105" width="94" height="98" rx="22" fill="url(#guide-book-cover)" stroke="url(#guide-edge)" strokeWidth="1.5" /><rect x="112" y="130" width="47" height="47" rx="8" stroke="#D3E4FF" strokeWidth="2.5" /><path d="M112 144h47m-36-21v12m24-12v12m-24 20h7m10 0h7m-24 11h7" stroke="#D3E4FF" strokeWidth="2.5" strokeLinecap="round" /></g>
    <g filter="url(#guide-shadow)"><circle cx="449" cy="307" r="40" fill="url(#guide-book-cover)" stroke="url(#guide-edge)" strokeWidth="1.5" /><path d="m433 307 11 11 21-24" stroke="#E9F2FF" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></g>
    <circle cx="200" cy="93" r="5" fill="#5996FF" /><circle cx="483" cy="198" r="3" fill="#8AB9FF" /><circle cx="83" cy="282" r="3" fill="#548FFF" />
  </svg>
}
