import { createRoot } from 'react-dom/client'
import RootErrorBoundary from '../../src/pages/error/root-error-boundary.tsx'
import '../../src/index.scss'
const theme=new URLSearchParams(location.search).get('theme');if(theme==='dark')document.documentElement.dataset.theme='dark'
export function Failure():never{throw new Error('Synthetic profile boundary acceptance')}
createRoot(document.getElementById('root')!).render(<RootErrorBoundary><Failure/></RootErrorBoundary>)
