import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
export default function VacationWarning({organizationId,startDate,endDate,memberId}:{organizationId:string;startDate:string;endDate:string;memberId?:string}){
 const {apiRequest,locationId}=useAuth()
 const q=useQuery({queryKey:['vacation-warnings',organizationId,startDate,endDate,memberId,locationId],enabled:!!startDate&&!!endDate&&startDate<=endDate,queryFn:()=>apiRequest<{days:number;otherEmployees:number;shifts:number}>(`/organizations/${organizationId}/vacation-warnings?startDate=${startDate}&endDate=${endDate}${memberId?'&subjectMemberId='+memberId:''}`)})
 return q.data?<p className="absence-note">Дней отпуска: {q.data.days}. В эти даты отпуск у {q.data.otherEmployees} коллег; пересекающихся смен: {q.data.shifts}. Пересечение отпусков допустимо, смены потребуют отдельного решения.</p>:q.isError?<p className="absence-note">Не удалось проверить пересечения. <button className="app-secondary" type="button" onClick={()=>void q.refetch()}>Повторить</button></p>:null
}
