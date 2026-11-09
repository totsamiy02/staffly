import { useQuery } from '@tanstack/react-query'
import { guideExampleIds,type GuideExampleId } from '../../pages/guide/content/types.ts'
/* oxlint-disable react/only-export-components -- Public content hook and renderer share the contract. */
import { Children,isValidElement,lazy,Suspense,useEffect,useState,type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GuideArticle } from '../../pages/guide/content/types.ts'
import './content.scss'
export type PublishedContent={key:string;kind:string;title:string;body:string;metadata?:{category?:GuideArticle['category'];audience?:GuideArticle['audience'];summary?:string};revision:number;effective_at:string;published_at:string;summary?:string;matches?:boolean;reading_minutes?:number}
const publishedExample=lazy(()=>import('../../pages/guide/guide-example-block.tsx'))
const Example=publishedExample
export function usePublishedContent(key:string,enabled=true){
 const query=useQuery<PublishedContent|null>({queryKey:['public-content',key],enabled,staleTime:30000,refetchInterval:60000,retry:false,queryFn:async({signal})=>{const response=await fetch('/api/public/content/'+encodeURIComponent(key),{signal,credentials:'omit'});if(!response.ok)throw new Error('Content unavailable');const item=await response.json();return item&&typeof item.body==='string'?item:null}})
 return{key,item:query.data??null,loaded:!query.isPending}
}
export function usePublishedGuideCatalogState(query=''){
 const [search,setSearch]=useState(query);useEffect(()=>{const timer=setTimeout(()=>setSearch(query),query?300:0);return()=>clearTimeout(timer)},[query])
 return useQuery<PublishedContent[]>({queryKey:['public-guide-catalog',search],staleTime:30000,refetchInterval:60000,retry:false,queryFn:async({signal})=>{const response=await fetch('/api/public/content?kind=guide&search='+encodeURIComponent(search),{signal,credentials:'omit'});if(!response.ok)throw new Error('Content unavailable');const value=await response.json();return Array.isArray(value.items)?value.items:[]}})
}
export const usePublishedGuideCatalog=(query='')=>usePublishedGuideCatalogState(query).data??[]
export function mergeGuideArticles(original:GuideArticle[],published:PublishedContent[],query=''){
 const map=new Map(original.map(a=>[a.slug,a]));for(const item of published){const slug=item.key.replace(/^guide:/,''),base=map.get(slug);if(query&&item.matches===false){map.delete(slug);continue}map.set(slug,{slug,category:item.metadata?.category??base?.category??'start',title:item.title,summary:item.metadata?.summary??item.summary??item.body?.replace(/[#*`]/g,'').slice(0,180)??'',audience:item.metadata?.audience??base?.audience??'everyone',updated:item.effective_at.slice(0,10),publishedReadingMinutes:item.reading_minutes,keywords:query?query.split(/\s+/):[],sections:[],related:base?.related??[],sources:base?.sources??[]})}return [...map.values()]
}
function headingText(value:ReactNode):string{return Children.toArray(value).map(child=>typeof child==='string'||typeof child==='number'?String(child):isValidElement<{children?:ReactNode}>(child)?headingText(child.props.children):'').join('')}
export function PublishedMarkdown({children,anchorPrefix=''}:{children:string;anchorPrefix?:string}){
 const heading=(Tag:'h2'|'h3',value:ReactNode)=>{const parts=Children.toArray(value),last=parts.at(-1),match=typeof last==='string'?last.match(/\s*\{#([a-zA-Z0-9_-]{1,100})\}$/):null;if(match&&typeof last==='string')parts[parts.length-1]=last.slice(0,-match[0].length);const id=anchorPrefix+(match?.[1]??headingText(parts).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,''));return <Tag id={id}>{parts}</Tag>}
 return <div className="published-content"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
 a:({children,href})=><a href={href?.startsWith('#')?'#'+anchorPrefix+href.slice(1):href} rel="noreferrer">{children}</a>,img:({alt})=><span>{alt}</span>,h2:({children})=>heading('h2',children),h3:({children})=>heading('h3',children),
 pre:({children,node})=>node?.children.some(child=>child.type==='element'&&child.properties?.className?.toString().includes('language-staffly-example'))?<div className="published-guide-example">{children}</div>:<pre>{children}</pre>,
 code:({children,className})=>className==='language-staffly-example'&&guideExampleIds.includes(String(children).trim() as GuideExampleId)?<Suspense fallback={<p role="status">Загружаем пример…</p>}><Example example={String(children).trim() as GuideExampleId}/></Suspense>:<code className={className}>{children}</code>
 }}>{children}</ReactMarkdown></div>
}
export function PublicContentSlot({name,children}:{name:string;children?:ReactNode}){const {item}=usePublishedContent(name);return item?<section className="public-content-section">{name==='home'?<h1>{item.title}</h1>:<h2>{item.title}</h2>}<PublishedMarkdown>{item.body}</PublishedMarkdown></section>:children??null}
export function PublicServiceNotice(){
 const {pathname}=useLocation(),announcement=usePublishedContent('announcement',!pathname.startsWith('/admin')),[windows,setWindows]=useState<Array<{id:string;starts_at:string;ends_at:string;announcement:string}>>([])
 useEffect(()=>{if(pathname.startsWith('/admin'))return;const controller=new AbortController();const read=()=>void fetch('/api/public/service-notice',{signal:controller.signal,credentials:'omit'}).then(r=>r.ok?r.json():{windows:[]}).then(r=>{if(!controller.signal.aborted)setWindows(r.windows)}).catch(()=>{});read();const timer=setInterval(read,30000);return()=>{controller.abort();clearInterval(timer)}},[pathname])
 if(pathname.startsWith('/admin'))return null
 const active=windows.filter(w=>Date.parse(w.ends_at)>Date.now())
 return <>{announcement.item&&<aside className="public-service-notice" aria-label="Объявление сервиса"><strong>{announcement.item.title}</strong><PublishedMarkdown>{announcement.item.body}</PublishedMarkdown></aside>}{active.map(w=><aside key={w.id} className="public-service-notice" aria-label="Плановое обслуживание"><strong>{Date.parse(w.starts_at)>Date.now()?'Запланировано обслуживание':'Идёт обслуживание'}</strong><span>{w.announcement}</span><small>{new Date(w.starts_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} — {new Date(w.ends_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} · МСК</small></aside>)}</>
}
