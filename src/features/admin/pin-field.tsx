import { useId } from 'react'

export default function PinField({value,onChange,label='PIN-код',invalid=false,autoFocus=false,masked=true,readOnly=false}:{value:string;onChange:(value:string)=>void;label?:string;invalid?:boolean;autoFocus?:boolean;masked?:boolean;readOnly?:boolean}) {
 const id=useId()
 return <label className={`admin-pin-field ${invalid?'is-invalid':''}`} htmlFor={id}><span>{label}</span><div className="admin-pin-control">
  <input id={id} name="staffly-unlock-code" type="text" inputMode="numeric" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true" data-form-type="other" pattern="[0-9]{6}" maxLength={6} required readOnly={readOnly} value={value} autoFocus={autoFocus} aria-invalid={invalid} onChange={event=>onChange(event.target.value.replace(/\D/g,'').slice(0,6))}/>
  <span className="admin-pin-cells" aria-hidden="true">{Array.from({length:6},(_,index)=><i key={index} className={`${index===value.length?'is-current':''} ${value[index]?'is-filled':''}`}>{value[index]?(masked?'•':value[index]):''}</i>)}</span>
 </div></label>
}
