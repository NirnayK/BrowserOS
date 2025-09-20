import { Logging } from '@/lib/utils/Logging'
import { MessageType } from '@/lib/runtime/MessageManager'

type BetterSqlite3Module = new (path: string, options?: Record<string, unknown>) => BetterSqlite3Database

interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement
  exec(sql: string): void
  pragma(query: string): unknown
  transaction<T extends unknown[]>(handler: (...args: T) => void): (...args: T) => void
  close(): void
}

interface BetterSqlite3Statement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): Array<Record<string, unknown>>
}

interface PreparedStatements {
  upsertConversation: BetterSqlite3Statement
  deleteMessages: BetterSqlite3Statement
  insertMessage: BetterSqlite3Statement
  deleteConversation: BetterSqlite3Statement
  selectMessages: BetterSqlite3Statement
}

export interface ChatMemoryMessage {
  role: MessageType
  content: string
  sequence: number
  createdAt?: number
  metadata?: Record<string, unknown>
}

export interface ChatMemoryAdapter {
  initialize(): void
  isAvailable(): boolean
  replaceConversation(conversationId: string, messages: ChatMemoryMessage[]): void
  getMessages(conversationId: string): ChatMemoryMessage[]
  clearConversation(conversationId: string): void
}

export interface SQLiteChatMemoryOptions {
  dbPath?: string
  journalMode?: string
}

function dynamicRequire(moduleName: string): any {
  try {
    const req = (0, eval)('require') as ((name: string) => unknown) | undefined
    if (typeof req === 'function') {
      return req(moduleName)
    }
  } catch {
    // Ignore - module not available in this runtime
  }
  return null
}

export class SQLiteChatMemory implements ChatMemoryAdapter {
  private readonly dbPath: string
  private readonly journalMode: string
  private database: BetterSqlite3Database | null = null
  private statements: PreparedStatements | null = null
  private initialized = false
  private driver: BetterSqlite3Module | null = null

  constructor(options: SQLiteChatMemoryOptions = {}) {
    this.dbPath = this.resolveDatabasePath(options.dbPath)
    this.journalMode = options.journalMode ?? 'WAL'
  }

  initialize(): void {
    this.ensureDatabase()
  }

  isAvailable(): boolean {
    return this.ensureDatabase() !== null
  }

  replaceConversation(conversationId: string, messages: ChatMemoryMessage[]): void {
    const db = this.ensureDatabase()
    if (!db || !this.statements) return

    const now = Date.now()
    const run = db.transaction((rows: ChatMemoryMessage[]) => {
      this.statements!.upsertConversation.run(conversationId, now, now)
      this.statements!.deleteMessages.run(conversationId)

      for (const row of rows) {
        const metadataJson = row.metadata ? JSON.stringify(row.metadata) : null
        const createdAt = row.createdAt ?? now
        this.statements!.insertMessage.run(
          conversationId,
          row.role,
          row.content,
          metadataJson,
          row.sequence,
          createdAt
        )
      }
    })

    try {
      run(messages)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logging.log('SQLiteChatMemory', `Failed to persist chat history: ${message}`, 'error')
    }
  }

  getMessages(conversationId: string): ChatMemoryMessage[] {
    const db = this.ensureDatabase()
    if (!db || !this.statements) return []

    try {
      const rows = this.statements.selectMessages.all(conversationId)
      return rows.map(row => this.deserializeRow(row))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logging.log('SQLiteChatMemory', `Failed to load chat history: ${message}`, 'error')
      return []
    }
  }

  clearConversation(conversationId: string): void {
    const db = this.ensureDatabase()
    if (!db || !this.statements) return

    const run = db.transaction((id: string) => {
      this.statements!.deleteMessages.run(id)
      this.statements!.deleteConversation.run(id)
    })

    try {
      run(conversationId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logging.log('SQLiteChatMemory', `Failed to clear chat history: ${message}`, 'warning')
    }
  }

  private ensureDatabase(): BetterSqlite3Database | null {
    if (this.database) {
      return this.database
    }

    try {
      const Driver = this.loadDriver()
      if (!Driver) {
        throw new Error('better-sqlite3 module is not available')
      }

      this.ensureDirectoryExists(this.dbPath)
      this.database = new Driver(this.dbPath)
      this.database.pragma(`journal_mode = ${this.journalMode}`)
      this.database.pragma('foreign_keys = ON')
      this.createSchema()
      this.prepareStatements()
      this.initialized = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logging.log('SQLiteChatMemory', `Failed to initialize SQLite memory: ${message}`, 'warning')
      this.database = null
      this.statements = null
    }

    return this.database
  }

  private loadDriver(): BetterSqlite3Module | null {
    if (this.driver) {
      return this.driver
    }

    const loaded = dynamicRequire('better-sqlite3')
    if (loaded) {
      this.driver = loaded as BetterSqlite3Module
    }
    return this.driver
  }

  private createSchema(): void {
    if (!this.database) return

    const schema = `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_sequence
        ON chat_messages(conversation_id, sequence);
    `

    this.database.exec(schema)
  }

  private prepareStatements(): void {
    if (!this.database) return

    this.statements = {
      upsertConversation: this.database.prepare(`
        INSERT INTO conversations (id, created_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `),
      deleteMessages: this.database.prepare('DELETE FROM chat_messages WHERE conversation_id = ?'),
      insertMessage: this.database.prepare(`
        INSERT INTO chat_messages (
          conversation_id,
          role,
          content,
          metadata,
          sequence,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `),
      deleteConversation: this.database.prepare('DELETE FROM conversations WHERE id = ?'),
      selectMessages: this.database.prepare(`
        SELECT role, content, metadata, sequence, created_at
        FROM chat_messages
        WHERE conversation_id = ?
        ORDER BY sequence ASC
      `)
    }
  }

  private deserializeRow(row: Record<string, unknown>): ChatMemoryMessage {
    const metadataRaw = row.metadata
    let metadata: Record<string, unknown> | undefined

    if (typeof metadataRaw === 'string' && metadataRaw.length > 0) {
      try {
        metadata = JSON.parse(metadataRaw) as Record<string, unknown>
      } catch {
        metadata = undefined
      }
    }

    return {
      role: row.role as MessageType,
      content: typeof row.content === 'string' ? row.content : '',
      sequence: typeof row.sequence === 'number' ? row.sequence : Number(row.sequence ?? 0),
      createdAt: typeof row.created_at === 'number' ? row.created_at : undefined,
      metadata
    }
  }

  private ensureDirectoryExists(filePath: string): void {
    const fs = dynamicRequire('fs') as typeof import('fs') | null
    const pathModule = dynamicRequire('path') as typeof import('path') | null

    if (!fs || !pathModule) return

    try {
      const dir = pathModule.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    } catch {
      // Ignore directory creation errors
    }
  }

  private resolveDatabasePath(provided?: string): string {
    if (provided && provided.trim().length > 0) {
      return provided
    }

    const envPath = typeof process !== 'undefined' ? process.env?.BROWSEROS_CHAT_MEMORY_PATH : undefined
    if (envPath && envPath.trim().length > 0) {
      return envPath
    }

    const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function'
      ? process.cwd()
      : '.'

    const pathModule = dynamicRequire('path') as typeof import('path') | null
    if (pathModule) {
      return pathModule.join(cwd, 'chat_memory.sqlite')
    }

    const normalized = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
    return `${normalized}/chat_memory.sqlite`
  }
}

export class InMemoryChatMemory implements ChatMemoryAdapter {
  private readonly store = new Map<string, ChatMemoryMessage[]>()

  initialize(): void {
    // No-op
  }

  isAvailable(): boolean {
    return true
  }

  replaceConversation(conversationId: string, messages: ChatMemoryMessage[]): void {
    this.store.set(conversationId, messages.map(message => ({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined })))
  }

  getMessages(conversationId: string): ChatMemoryMessage[] {
    const messages = this.store.get(conversationId)
    if (!messages) return []
    return messages.map(message => ({
      ...message,
      metadata: message.metadata ? { ...message.metadata } : undefined
    }))
  }

  clearConversation(conversationId: string): void {
    this.store.delete(conversationId)
  }
}
