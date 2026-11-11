export default function OpeningHoursWarning({checked,onChange,className='planning-checkbox'}:{checked:boolean;onChange:(checked:boolean)=>void;className?:string}){
 return <label className={className}><input type="checkbox" name="ackOpeningHours" checked={checked} onChange={e=>onChange(e.target.checked)}/><span>Подтверждаю назначение смен за пределами часов работы точки</span></label>
}
