import './form-safety.scss'
export default function FormDraftNotice({ form }: { form: { candidate: unknown; stale: boolean; saved: boolean; storageError: boolean; restore: () => void; deleteDraft: () => void } }) {
  if (form.candidate) return <div className="form-draft-notice" role="status"><div><strong>Есть несохранённый черновик</strong><p>{form.stale ? 'Исходные данные изменились. После восстановления сохранение потребует сверки с актуальной версией.' : 'Черновик доступен в этой вкладке в течение 24 часов. Он ещё не отправлен на сервер.'}</p></div><div className="form-draft-notice__actions"><button type="button" className="app-secondary" onClick={form.restore}>Восстановить</button><button type="button" className="app-secondary" onClick={form.deleteDraft}>Удалить черновик</button></div></div>
  if (form.storageError) return <p className="form-inline-error" role="status">Черновик не сохраняется в браузере. Введённые данные остаются в форме; не закрывайте вкладку до сохранения.</p>
  if (form.stale) return <p className="form-inline-error" role="status">Исходная запись уже изменилась. Сверьте актуальные данные перед сохранением; автоматическая перезапись новой версии заблокирована.</p>
  return form.saved ? <p className="form-draft-status" role="status">Черновик сохранён в этой вкладке · 24 часа · до выхода из аккаунта</p> : null
}
