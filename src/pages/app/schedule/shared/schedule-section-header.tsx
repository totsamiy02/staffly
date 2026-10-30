import PageHeading from '../../../../component/ui/page-heading/page-heading.tsx'
import type { ReactNode } from 'react'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import ScheduleTabs from './schedule-tabs.tsx'
import './schedule-section-header.scss'
export default function ScheduleSectionHeader({organization,title,description,children}:{organization:OrganizationSummary;title:string;description:string;children?:ReactNode}) {
  return <div className="schedule-section-header"><PageHeading className="schedule-section-heading" title={title} description={description} actions={children && <div className="schedule-section-actions">{children}</div>}/><ScheduleTabs organization={organization}/></div>
}
