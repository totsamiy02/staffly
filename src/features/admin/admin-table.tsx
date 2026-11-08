import AdminDisclosure from './admin-disclosure.tsx'
import AdminPopover from './admin-popover.tsx'
import { Children,Fragment,cloneElement,isValidElement,useSyncExternalStore,type ReactElement,type ReactNode } from 'react'
import CopyReference from '../../component/ui/copy-reference.tsx'
import { SupportReference } from '../../component/ui/request-error-message.tsx'
type Element=ReactElement<{children?:ReactNode;className?:string;label?:string}>
const compact=()=>window.matchMedia('(max-width: 900px)').matches
const subscribe=(callback:()=>void)=>{const query=window.matchMedia('(max-width: 900px)');query.addEventListener('change',callback);return()=>query.removeEventListener('change',callback)}
const nodes=(value:ReactNode):Element[]=>Children.toArray(value).flatMap(node=>isValidElement(node)?node.type===Fragment?nodes((node as Element).props.children):[node as Element]:[])
/** One data tree: desktop rows become readable cards with persistent actions. */
export default function AdminTable({children,primary=[0,1],actions=[],title=0}:{children:ReactNode;primary?:number[];actions?:number[];title?:number}){
 const small=useSyncExternalStore(subscribe,compact,()=>false),contents=Children.toArray(children),table=contents.find(node=>isValidElement(node)&&node.type==='table') as Element|undefined
 if(!table)return <div className="admin-table-wrap">{children}</div>
 const parts=nodes(table.props.children),head=parts.find(node=>node.type==='thead'),body=parts.find(node=>node.type==='tbody')
 const headers=nodes(nodes(head?.props.children)[0]?.props.children),rows=nodes(body?.props.children)
 const after=contents.filter(node=>node!==table)
 if(!small)return <div className="admin-table-wrap">{cloneElement(table,{},parts.map(part=>part.type==='tbody'?cloneElement(part,{},rows.map((row,index)=>cloneElement(row,{'data-admin-record':String(row.key??index)} as never))):part))}{after}</div>
 return <div className="admin-mobile-table"><div className="admin-record-list">{rows.map((row,index)=>{
  const cells=nodes(row.props.children),extra:Array<{label:ReactNode;value:ReactNode}>=[]
  const summary=(cell:Element,i:number)=>Children.toArray(cell.props.children).filter(node=>{
   if(isValidElement(node)&&(node.type===SupportReference||node.type===CopyReference||node.type==='details'||node.type===AdminDisclosure||node.type===AdminPopover)){const item=node as Element;extra.push({label:item.props.label??headers[i]?.props.children??'Идентификатор',value:node});return false}return true
  })
  const main=new Map(primary.map(i=>[i,cells[i]?summary(cells[i],i):null]))
  const secondary=cells.map((cell,i)=>({label:headers[i]?.props.children,value:cell.props.children,index:i})).filter(item=>!primary.includes(item.index)&&!actions.includes(item.index))
  return <article className="admin-record-card" data-admin-record={String(row.key??index)} key={row.key??index}>
   <div className="admin-record-title">{main.get(title)??cells[title]?.props.children}</div>
   <dl className="admin-record-main">{primary.filter(i=>i!==title).map(i=><div key={i}><dt>{headers[i]?.props.children}</dt><dd>{main.get(i)}</dd></div>)}</dl>
   {actions.length>0&&<div className="admin-record-actions">{actions.map(i=><div key={i}>{cells[i]?.props.children}</div>)}</div>}
   {(secondary.length>0||extra.length>0)&&<AdminDisclosure className="admin-record-details" label="Подробности"><dl>{[...secondary,...extra].map((item,i)=><div key={i}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></AdminDisclosure>}
  </article>
 })}</div>{after}</div>
}
