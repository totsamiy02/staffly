import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { PlanCards } from '../../pages/app/subscriptions/plan-ui.tsx'
import type { PlanId } from '../../app/subscriptions/plans.ts'
import './pricing.scss'
export default function Pricing() {
  const navigate = useNavigate(), { user } = useAuth()
  function choose(plan: PlanId) {
    const target = plan === 'FREE' ? '/app/organizations/new?plan=FREE' : `/app?plan=${plan}`
    navigate(user ? target : `/auth?mode=register&returnTo=${encodeURIComponent(target)}`)
  }
  return <section className="pricing" id="pricing"><div className="container"><h2>Тариф под вашу команду</h2><p className="pricing__intro">Новые организации начинают бесплатно. Владелец каждой организации может подключить нужный тариф самостоятельно, без оплаты.</p><PlanCards onChoose={choose} /><p className="pricing__footnote">Банковские реквизиты не требуются. Квоты участников, точек и хранилища действуют для каждой организации отдельно.</p></div></section>
}
