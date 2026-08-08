import './benefits.scss'

const benefits = [
  {
    icon: '⚡',
    title: 'Быстрый старт',
    description: 'Создайте организацию и начните работу за несколько минут.',
  },
  {
    icon: '👥',
    title: 'Управление сотрудниками',
    description: 'Все данные о сотрудниках и структуре компании в одном месте.',
  },
  {
    icon: '📅',
    title: 'Удобное расписание',
    description: 'Планируйте смены и рабочее время без таблиц Excel.',
  },
]

function Benefits() {
  return (
    <section className="benefits" id="benefits">
      <div className="container">
        <h2>Почему стоит выбрать именно нас?</h2>

        <div className="benefits__list">
          {benefits.map((benefit) => (
            <article className="benefit-card" key={benefit.title}>
              <h3>
                <span aria-hidden="true">{benefit.icon}</span>
                {benefit.title}
              </h3>

              <div className="benefit-card__description">
                <span className="benefit-card__icon" aria-hidden="true">
                  ✓
                </span>
                <p>{benefit.description}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Benefits
