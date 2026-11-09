import './guide-example-block.scss'
import { useState } from 'react'
import type { GuideExampleId } from './content/types.ts'
import GuideExample from './guide-examples.tsx'
import { guideExampleLabels } from './guide-example-labels.ts'
import GuideIcon from './guide-icon.tsx'
import AnimatedOverlay from '../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../component/ui/modal/document-dialog.tsx'
export default function GuideExampleBlock({example}:{example:GuideExampleId}){
 const [zoom,setZoom]=useState(false)
 return <><figure className="guide-figure"><div className="guide-figure__frame"><div className="guide-figure__label"><GuideIcon name="window"/>В интерфейсе Staffly</div><GuideExample example={example}/><button type="button" onClick={()=>setZoom(true)} aria-label={'Увеличить: '+guideExampleLabels[example]}><GuideIcon name="zoom"/>Увеличить</button></div><figcaption>{guideExampleLabels[example]} · фрагмент интерфейса с вымышленными данными</figcaption></figure>{zoom&&<AnimatedOverlay variant="modal" className="guide-example-overlay" onClose={()=>setZoom(false)}>{close=><DocumentDialog title={guideExampleLabels[example]} eyebrow="Пример интерфейса" className="guide-example-dialog" onClose={close}><div className="guide-example-stage" role="region" aria-label="Увеличенный пример интерфейса, доступна горизонтальная прокрутка" tabIndex={0}><GuideExample example={example}/></div><p>Вымышленные данные. Элементы внутри примера не выполняют действия.</p></DocumentDialog>}</AnimatedOverlay>}</>
}
