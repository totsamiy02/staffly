import { randomUUID, createHash } from 'node:crypto'
import { hash } from 'argon2'
import { prisma } from '../../src/server/db.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'
import { storage } from '../../src/server/storage/provider.ts'

export async function interfaceFixtures(namespace = '') {
  const password = 'Interface-Test-Only-4729!'
  const owner = await prisma.user.create({ data: { email: `interface-owner${namespace}@example.test`, passwordHash: await hash(password), emailVerifiedAt: new Date(), firstName: 'Александра', lastName: 'Константинопольская-Рождественская', middleName: 'Александровна', bio: 'Длинное описание профиля для проверки переноса текста и адаптивных полей. '.repeat(5).trim(), phone: '+79991234567' } })
  const org = await createBusinessOrganization(owner.id, { name: 'Объединённая производственная организация с очень длинным названием и несколькими подразделениями', description: 'Проверка интерфейса на синтетических данных.', timezone: 'Europe/Moscow', firstLocation: { name: 'Центральное подразделение с очень длинным названием', city: 'Санкт-Петербург', address: 'Длинный адрес: набережная Промышленная, дом 123, корпус 45', timezone: 'Europe/Moscow' }, locations: [{ name: 'Вторая точка', city: 'Москва', address: 'Тестовая, 2', timezone: 'Europe/Moscow' }] })
  const member = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
  await prisma.organizationLocation.updateMany({ where: { organizationId: org.id }, data: { coverageEnabled: true, discussionEnabled: true } })
  const people = []
  for (let index = 0; index < 24; index++) {
    const user = await prisma.user.create({ data: { email: `interface-${index}${namespace}@example.test`, emailVerifiedAt: new Date(), firstName: index === 0 ? 'Оченьдлинноеимясотрудникабезпробелов' : 'Сотрудник', lastName: index === 0 ? 'Константинопольский-Рождественский-Архангельский' : `Тестовый ${String(index + 1).padStart(2, '0')}`, middleName: 'Александрович' } })
    const item = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })
    await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: item.id } })
    people.push(item)
  }
  const now = new Date(), month = now.toISOString().slice(0, 7), day = `${month}-12`
  await prisma.workShift.createMany({ data: [member, ...people.slice(0, 8)].map((person, index) => ({ organizationId: org.id, locationId: org.locationId, memberId: person.id, createdByMemberId: member.id, scheduledStartAt: new Date(`${day}T06:00:00Z`), scheduledEndAt: new Date(`${day}T14:00:00Z`), ...(index < 2 ? { actualStartAt: new Date(`${day}T06:00:00Z`), actualEndAt: new Date(`${day}T14:00:00Z`) } : {}) })) })
  const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.id, systemCode: 'OTHER' } })
  await prisma.organizationRequest.createMany({ data: people.slice(0, 7).map((person, index) => ({ organizationId: org.id, locationId: org.locationId, createdByMemberId: person.id, requestTypeId: type.id, typeNameSnapshot: type.name, systemCodeSnapshot: 'OTHER' as const, status: index ? 'PENDING' as const : 'RETURNED' as const, comment: 'Длинный текст обращения для проверки переносов и высоты карточек. '.repeat(8).trim() })) })
  const key = `organizations/${org.id}/documents/${randomUUID()}.txt`, bytes = Buffer.from('Синтетический документ для проверки интерфейса.\n'.repeat(5).trim())
  const file = await prisma.storedFile.create({ data: { organizationId: org.id, uploadedByUserId: owner.id, purpose: 'DOCUMENT', objectKey: key, mimeType: 'text/plain', size: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex') } })
  await storage.put(key, bytes)
  const document = await prisma.document.create({ data: { organizationId: org.id, locationId: org.locationId, storedFileId: file.id, uploadedByMemberId: member.id, visibility: 'ORGANIZATION', displayName: 'Документ с длинным названием для проверки адаптивных карточек и списков', fileName: 'document-with-a-long-name-for-interface-tests.txt' } })
  await prisma.documentAcknowledgement.create({ data: { documentId: document.id, memberId: member.id, assignedByMemberId: member.id } })
  const event = await prisma.organizationEvent.create({ data: { organizationId: org.id, title: 'Производственное совещание с длинным названием события', description: 'Описание события. '.repeat(30).trim(), startAt: new Date(+now + 86400_000), timezone: 'Europe/Moscow', audienceMode: 'ALL', createdByMemberId: member.id, updatedByMemberId: member.id } })
  await prisma.eventLocation.create({ data: { organizationId: org.id, eventId: event.id, locationId: org.locationId } })
  const draft = await prisma.scheduleDraft.create({ data: { organizationId: org.id, locationId: org.locationId, authorMemberId: member.id, title: 'Предварительный график с длинным названием', fromDate: new Date(`${month}-01T00:00:00Z`), toDate: new Date(`${month}-28T00:00:00Z`), timezone: 'Europe/Moscow' } })
  const token = randomUUID() + randomUUID()
  await prisma.authSession.create({ data: { userId: owner.id, refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(+now + 4 * 3600000), absoluteExpiresAt: new Date(+now + 4 * 3600000) } })
  return { owner, org, member, people, document, event, draft, token, password }
}
