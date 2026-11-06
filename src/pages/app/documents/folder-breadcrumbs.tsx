type Crumb = { id: string; name: string }

export default function FolderBreadcrumbs({ currentId, items, onNavigate, onBack, backDisabled = false }: { currentId: string; items: Crumb[]; onNavigate: (id: string) => void; onBack: () => void; backDisabled?: boolean }) {
  return <nav className="document-breadcrumbs" aria-label="Расположение папки">
    {currentId && <button type="button" className="document-folder-nav" aria-label="На уровень выше" disabled={backDisabled} onClick={onBack}>← Назад</button>}
    <button type="button" aria-current={!currentId ? 'page' : undefined} onClick={() => onNavigate('')}>Библиотека</button>
    {items.map(item => <span key={item.id}><span aria-hidden="true">/</span><button type="button" aria-current={item.id === currentId ? 'page' : undefined} onClick={() => onNavigate(item.id)}>{item.name}</button></span>)}
  </nav>
}
