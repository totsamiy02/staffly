import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '../../src/app/auth/auth-context.tsx'
import ToastProvider from '../../src/component/ui/toast/toast.tsx'
import DocumentDialog from '../../src/component/ui/modal/document-dialog.tsx'
import AnimatedOverlay from '../../src/component/ui/modal/animated-overlay.tsx'
import Select from '../../src/component/ui/select/select.tsx'
import DatePicker, { TimeInput } from '../../src/component/ui/date-picker/date-picker.tsx'
import MonthPicker from '../../src/component/ui/month-picker/month-picker.tsx'
import MemberPicker from '../../src/component/ui/member-picker/member-picker.tsx'
import HelpTip from '../../src/component/ui/help-tip/help-tip.tsx'
import '../../src/index.scss'
import '../../src/pages/app/app.scss'

export default function Controls() {
  const [open, setOpen] = useState(false), [nested, setNested] = useState(false), [value, setValue] = useState('one'), [date, setDate] = useState('2026-10-20'), [time, setTime] = useState('09:00'), [month, setMonth] = useState('2026-10'), [people, setPeople] = useState<string[]>([])
  const fields = <><label><span>Первое поле</span><input name="first" /></label><label><span>Обычный список</span><Select value={value} onChange={e => setValue(e.target.value)}><option value="one">Первое значение</option><option value="disabled" disabled>Недоступное значение</option><option value="two">Оченьдлинноезначениеспискабезпробеловдляпроверкипереноса</option></Select></label><label><span>Поиск в списке</span><Select searchable value={value} onChange={e => setValue(e.target.value)}><option value="one">Первое значение</option><option value="two">Другое значение</option></Select></label><label><span>Дата</span><DatePicker value={date} onChange={e => setDate(e.target.value)} /></label><label><span>Время</span><TimeInput value={time} onChange={e => setTime(e.target.value)} /></label><MonthPicker value={month} onChange={setMonth} currentMonth="2026-10" /><MemberPicker members={[{ id: 'one', displayName: 'Константинопольский-Рождественский Александр Александрович' }, { id: 'two', displayName: 'Оченьдлинноеимясотрудникабезпробеловдляпроверки' }]} value={people} onChange={setPeople} /><div>Пояснение <HelpTip label="Помощь по полю">Полезное пояснение к полю.</HelpTip></div><label><span>Последнее поле</span><input name="last" /></label></>
  return <main className="organization-form-page" style={{ margin: '24px auto', padding: '16px', maxWidth: '620px' }}><h1>Общие компоненты</h1><button className="app-primary" onClick={() => setOpen(true)}>Открыть окно</button><form className="organization-form" onSubmit={e => e.preventDefault()}>{fields}<button className="app-primary">Отправить</button></form>{open && <AnimatedOverlay variant="modal" onClose={() => setOpen(false)}>{close => <DocumentDialog title="Проверка фокуса" onClose={close} scrollBody><form className="organization-form" onSubmit={e => e.preventDefault()}>{fields}<button type="button" onClick={() => setNested(true)}>Открыть вложенное окно</button><button type="button" className="app-primary" onClick={close}>Готово</button></form></DocumentDialog>}</AnimatedOverlay>}{nested && <AnimatedOverlay variant="modal" onClose={() => setNested(false)}>{close => <DocumentDialog title="Вложенное окно" onClose={close}><label>Поле вложенного окна<input autoFocus /></label><button type="button" onClick={close}>Закрыть вложенное окно</button></DocumentDialog>}</AnimatedOverlay>}</main>
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><QueryClientProvider client={new QueryClient()}><AuthProvider><ToastProvider><Controls /></ToastProvider></AuthProvider></QueryClientProvider></BrowserRouter>)
