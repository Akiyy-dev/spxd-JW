export type Role = 'admin' | 'committee' | 'student'
export type User = {id: string; username: string; name: string; role: Role; financeManage: boolean; mustChangePassword: boolean; active: boolean; version: number}
export const roleNames: Record<Role, string> = {admin: '管理员', committee: '班委', student: '学生'}

export type Config = {name: string; subtitle: string; introduction: string; academicYear: string; semesterStart: string; semesterEnd: string; holidays: string[]; demo: boolean; photoFileId?: string}
export type Member = {id: string; name: string; displayName?: string; role: Role; position: string; avatarFileId: string | null}
export type Duty = {id: string; date: string; area: string; names: string[]}
export type ClassData = {config: Config; members: Member[]; duties: Duty[]; version: number}

export type Period = {id: number; label: string; start: string; end: string}
export type Course = {id: string; name: string; teacher: string; room: string; day: number; startPeriod: number; endPeriod: number; color: string; notes: string}
export type Exception = {id: string; date: string; courseId: string; action: 'cancel' | 'replace'; course?: Course}
export type Timetable = {date: string; effectiveDate: string; version: number; periods: Period[]; courses: Course[]; exceptions: Exception[]; config: Pick<Config, 'semesterStart' | 'semesterEnd' | 'holidays'>; today: Course[]}

export type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'file'
export type Field = {id: string; label: string; type: FieldType; required: boolean; options?: string[]}
export type Submission = {id: string; taskId: string; userId: string; name: string; text: string; answers: Record<string, unknown>; attachments: string[]; createdAt: string; late: boolean; version: number}
export type TaskKind = 'homework' | 'affairs'
export type Task = {id: string; kind: TaskKind; title: string; course: string; description: string; deadline: string | null; allowLate: boolean; requiresSubmission: boolean; attachmentRequired: boolean; status: 'draft' | 'published' | 'archived'; fields: Field[]; attachments: string[]; version: number; createdAt: string; updatedAt: string; authorName: string; participantCount: number; submittedCount: number; mySubmission: Submission | null; myParticipantStatus: 'required' | 'excused' | null}
export type Participant = {userId: string; name: string; status: 'required' | 'excused'; submitted: boolean}
export type Resource = {id: string; title: string; description: string; category: string; url: string; attachments: string[]; pinned: boolean; status: 'published' | 'archived'; version: number; updatedAt: string; authorName: string}
export type AttachmentPurpose = 'task-attachment' | 'submission' | 'resource' | 'receipt' | 'avatar' | 'class-photo'
export type FileInfo = {id: string; name: string; size: number; mime: string}

export type Entry = {id: string; type: 'opening' | 'income' | 'expense'; amount: number; category: string; description: string; date: string; receiptIds: string[]; publicReceipt: boolean; paymentId: string | null; voided: boolean; version: number; createdAt: string; authorName: string}
export type Fee = {id: string; title: string; amount: number; deadline: string | null; userIds: string[]; version: number; createdAt: string}
export type Payment = {id: string; feeId: string; userId: string; name: string; amount: number; date: string; description: string; receiptIds: string[]; publicReceipt: boolean; version: number; voided: boolean}
export type Ledger = {balance: number; income: number; expense: number; opening: number; entries: Entry[]; fees: Fee[]; payments: Payment[]; canManage: boolean; canViewAll: boolean}
