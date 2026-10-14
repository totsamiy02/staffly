import type { ReactNode } from 'react'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import ScheduleTabs from './schedule-tabs.tsx'
import './schedule-section-header.scss'
export default function ScheduleSectionHeader({organization,title,description,children}:{organization:OrganizationSummary;title:string;description:string;children?:ReactNode}) {
  return <div className="schedule-section-header"><header className="schedule-section-heading"><div><h1>{title}</h1><p>{description}</p></div>{children&&<div className="schedule-section-actions">{children}</div>}</header><ScheduleTabs organization={organization}/></div>
}
