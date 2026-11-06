import type { SubscriptionSnapshot } from '../../app/subscriptions/plans.ts'
export type AdminAccess = {eligible:boolean;state:'authenticate'|'setup-pin'|'locked'|'active';expiresAt?:string;lockAt?:string;pinSet?:boolean;reset?:boolean;attemptsRemaining?:number}
export type OrganizationMonitor = {id:string;name:string;timezone:string;createdAt:string;lastActiveAt:string|null;members:number;locations:number;storageBytes:number;online:number;onlineSessions:number;subscription:SubscriptionSnapshot;attention:boolean}
export type PageResult<T>={items:T[];total:number;page:number;pageSize:number}
export type OnlineSummary={users:number;sessions:number;organizations:number;at:string}
export type OnlineSample={at:string;users:number;organizations:number;sessions:number}
export type OverviewMonitor={totals:{organizations:number;new_organizations:number;users:number;new_users:number;active_month:number};online:OnlineSummary;history:OnlineSample[];onlineOrganizations:OrganizationMonitor[];newOrganizations:OrganizationMonitor[];startedAt:string;days:number}
export type OrganizationDetails=OrganizationMonitor&{ownerName:string|null;daily:Array<{day:string;users:number}>;features:Array<{feature:string;days:number}>;events:Array<{action:string;outcome:string;createdAt:string}>;startedAt:string}
export type UserMonitor={id:string;displayName:string;email:string;createdAt:string;emailVerified:boolean;lastSeenAt:string|null;organizations:number;sessions:number;online:boolean}
export type UsersMonitor=PageResult<UserMonitor>&{totals:{users:number;verified:number;deleted:number};online:OnlineSummary}
export type UserDetails=UserMonitor&{memberships:Array<{id:string;name:string;role:string}>;membershipsTotal:number;page:number;pageSize:number}
export type OnlineMonitor={online:OnlineSummary;organizations:PageResult<OrganizationMonitor>;history:OnlineSample[];peak:number;plans:Array<{plan:string;count:number}>;startedAt:string}
export type AnalyticsMonitor={totals:{day:number;week:number;month:number};daily:Array<{day:string;organizations:number}>;features:Array<{feature:string;organizations:number}>;funnel:{created:number;invited:number;team:number;schedule:number};cohorts:Array<{cohort:string;week:number;organizations:number}>;startedAt:string;days:number;timezone:string;lifetime:Record<string,number>;registrations:Array<{day:string;users:number;organizations:number}>}
