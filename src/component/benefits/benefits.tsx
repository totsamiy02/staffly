import './benefits.scss'

const benefits = [
  {
    icon: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3M18 6l-3 3m-6 6-3 3" />,
    title: 'Быстрый старт',
    description: 'Создайте организацию и приступайте к работе за несколько минут.',
  },
  {
    icon: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2H3Zm13-14a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5h-4" /></>,
    title: 'Сотрудники в одном месте',
    description: 'Храните сведения о сотрудниках и структуре компании в одной системе.',
  },
  {
    icon: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 10h18m-13 5h3m3 0h3" /></>,
    title: 'Понятное расписание',
    description: 'Планируйте смены и рабочее время без отдельных таблиц.',
  },
]

function Benefits() {
  return (
    <section className="benefits" id="benefits">
      <div className="container">
        <h2>Всё для работы с командой</h2>

        <div className="benefits__list">
          {benefits.map((benefit) => (
            <article className="benefit-card" key={benefit.title}>
              <span className="benefit-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  {benefit.icon}
                </svg>
              </span>
              <h3>{benefit.title}</h3>
              <p>{benefit.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Benefits
