import { BlackButton, WhiteButton } from '../ui/btn/button'
import './pricing.scss'

const plans = [
  {
    name: 'Бесплатный тариф',
    description: 'Для знакомства с системой',
    price: 0,
    features: [
      'До 5 сотрудников в организации',
      'Карточки сотрудников',
      'Базовое расписание',
    ],
    featured: true,
  },
  {
    name: 'Тариф Easy Start',
    description: 'Для небольшой организации',
    price: 200,
    features: [
      'До 20 сотрудников в организации',
      'Расписание и рабочие смены',
      'Задачи и внутренние документы',
    ],
    featured: false,
  },
  {
    name: 'Тариф Premium',
    description: 'Для растущего бизнеса',
    price: 800,
    features: [
      'До 50 сотрудников в организации',
      'Все модули без ограничений',
      'Приоритетная поддержка',
    ],
    featured: false,
  },
]

function Pricing() {
  return (
    <section className="pricing" id="pricing">
      <div className="container">
        <h2>Выберите подходящий тариф</h2>

        <div className="pricing__list">
          {plans.map((plan) => (
            <article className="pricing-card" key={plan.name}>
              <div>
                <h3>{plan.name}</h3>
                <p className="pricing-card__description">{plan.description}</p>

                <p className="pricing-card__price">
                  ₽{plan.price}
                  <span>/ месяц</span>
                </p>

                <ul className="pricing-card__features">
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <span aria-hidden="true">✓</span>
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pricing-card__action">
                {plan.featured ? (
                  <BlackButton>Попробовать</BlackButton>
                ) : (
                  <WhiteButton>Попробовать</WhiteButton>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Pricing
