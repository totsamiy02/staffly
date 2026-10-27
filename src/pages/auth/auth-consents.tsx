type Props = { consentData: boolean; consentTerms: boolean; onData: (value: boolean) => void; onTerms: (value: boolean) => void; attempted: boolean }
export default function AuthConsents({ consentData, consentTerms, onData, onTerms, attempted }: Props) {
  return <div className="auth__consents">
    <label className="auth__check"><input type="checkbox" checked={consentData} onChange={event => onData(event.target.checked)} /><span>Я согласен(на) с <a href="/personal-data-consent" target="_blank" rel="noopener noreferrer">обработкой персональных данных</a></span></label>
    {attempted && !consentData && <p className="auth__error">Необходимо согласие на обработку данных.</p>}
    <label className="auth__check"><input type="checkbox" checked={consentTerms} onChange={event => onTerms(event.target.checked)} /><span>Я ознакомлен(на) с <a href="/terms" target="_blank" rel="noopener noreferrer">Пользовательским соглашением</a></span></label>
    {attempted && !consentTerms && <p className="auth__error">Подтвердите ознакомление с соглашением.</p>}
  </div>
}
