import { timesheetMutationContext } from './schedule/timesheets/mutation-context.ts'
import { PrismaPg } from '@prisma/adapter-pg'

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>
type Operations = Pick<Transaction, 'queryRaw' | 'executeRaw' | 'commit' | 'rollback'>

// Prisma can fetch relations concurrently even in a single interactive transaction.
// A transaction owns one pg connection: serialize its I/O and release hooks only.
// Queries on different transactions and ordinary pooled reads remain independent.
export function serializePgTransaction<T extends Operations>(transaction: T): T {
  let pending = Promise.resolve()
  const schedule = <R>(work: () => Promise<R>): Promise<R> => {
    const result = pending.then(work)
    pending = result.then(() => {}, () => {})
    return result
  }
  const query = transaction.queryRaw.bind(transaction)
  const execute = transaction.executeRaw.bind(transaction)
  const commit = transaction.commit.bind(transaction)
  const rollback = transaction.rollback.bind(transaction)
  transaction.queryRaw = input => schedule(() => query(input))
  transaction.executeRaw = input => schedule(() => execute(input))
  transaction.commit = () => schedule(commit)
  transaction.rollback = () => schedule(rollback)
  return transaction
}

export class SequentialPrismaPg extends PrismaPg {
  override async connect() {
    const adapter = await super.connect()
    const start = adapter.startTransaction.bind(adapter)
    adapter.startTransaction = async isolation => {
      const transaction = serializePgTransaction(await start(isolation))
      const context = timesheetMutationContext.getStore()
      if (context) {
        try {
          await transaction.queryRaw({
            sql: "SELECT set_config('staffly.actor_user_id', $1, true), set_config('staffly.correction_reason', $2, true)",
            args: [context.userId, context.reason],
            argTypes: [{ scalarType: 'string', arity: 'scalar' }, { scalarType: 'string', arity: 'scalar' }],
          })
        } catch (error) {
          try {
            await transaction.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] })
          } finally {
            await transaction.rollback()
          }
          throw error
        }
      }
      return transaction
    }
    return adapter
  }
}
