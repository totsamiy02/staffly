import type { ShiftAccounting, workTimeRules } from '../../../shared/work-time.ts';
export type TimesheetShift = {
  id: string;
  memberId: string;
  name: string;
  number: string | null;
  position: string | null;
  date: string;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  plannedMinutes: number;
  actualMinutes: number;
  accounting?: ShiftAccounting;
  breakMinutes: number;
  actualBreakMinutes: number | null;
  attendance: string;
  reason: string | null;
  updatedAt: string;
};
export type TimesheetAbsence = {
  id: string;
  memberId: string;
  name: string;
  number: string | null;
  type: string;
  start: string;
  end: string;
  overlapStart: string;
  overlapEnd: string;
  days: number;
  vacationDays: number;
  dates: string[];
  reason: string | null;
  comment: string | null;
  requestId: string | null;
};
export type TimesheetMember = {
  id: string;
  name: string;
  number: string | null;
  former: boolean;
  positions: string;
  plannedMinutes: number;
  actualMinutes: number;
  confirmedShifts?: number;
  unconfirmedShifts?: number;
  workedShifts: number;
  noShows: number;
  vacationDays: number;
  sickDays: number;
  otherAbsenceDays: number;
};
export type TimesheetSnapshot = {
  // Retained for immutable versions created before direct fixation.
  approval?: {
    reviewerMemberId: string;
    reviewerName: string;
  };
  closure?: {
    memberId: string;
    name: string;
  };
  organization: string;
  location: string;
  timezone: string;
  month: string;
  generatedAt: string;
  calculationRules?: typeof workTimeRules;
  members: TimesheetMember[];
  shifts: TimesheetShift[];
  absences: TimesheetAbsence[];
  issues: Array<{
    code: string;
    message: string;
    shiftId?: string;
    requestId?: string;
  }>;
};
export type TimesheetData = {
  historyPagination: { page: number; pages: number; total: number };
  period: {
    id: string;
    status: string;
    revision: number;
    version: number;
  } | null;
  snapshot: TimesheetSnapshot;
  snapshotToken: string;
  versions: Array<{
    version: number;
    closedAt: string;
    closedByMemberId: string;
  }>;
  events: Array<{
    id: string;
    kind: string;
    actorMemberId: string | null;
    actorName: string;
    reason: string;
    createdAt: string;
    changes: unknown;
  }>;
  changedSinceClose: boolean;
  capabilities: {
    close: boolean;
    reopen: boolean;
    export: boolean;
    actual: boolean;
  };
};
export const absenceNames: Record<string, string> = {
  VACATION: 'Отпуск', SICK: 'Больничный', SICK_LEAVE: 'Больничный', DAY_OFF: 'Отгул', ABSENCE: 'Отсутствие',
};
export const attendanceNames: Record<string, string> = {
  UNCONFIRMED: 'Не подтверждено', WORKED: 'Отработана', PARTIAL: 'Частично отработана', NO_SHOW: 'Неявка',
};
