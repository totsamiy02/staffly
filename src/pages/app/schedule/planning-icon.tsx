export default function PlanningIcon({name}:{name:'people'|'coverage'}) {
  return <svg className="planning-icon" viewBox="0 0 24 24" aria-hidden="true">{name==='coverage'?<><path d="M4 3v17h17M8 15v-4m5 4V6m5 9v-6"/><path d="m7 6 4-3 4 1 5-2"/></>:<><circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/></>}</svg>
}
