import { PublicContentSlot } from '../../features/public-content/content.tsx'
import Hero from '../../component/hero/hero.tsx'
import Benefits from '../../component/benefits/benefits.tsx'
import Pricing from '../../component/pricing/pricing.tsx'
export default function HomePage(){return <main><PublicContentSlot name="home"><Hero /><Benefits /><Pricing /></PublicContentSlot><PublicContentSlot name="faq"/><PublicContentSlot name="contacts"/></main>}
