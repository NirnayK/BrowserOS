import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, it } from 'vitest'

import { PersistentMessageManager } from '@/lib/runtime/PersistentMessageManager'
import { SQLiteChatMemory } from '@/lib/runtime/memory/SQLiteChatMemory'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browseros-chat-memory-'))

const createDbPath = (name: string) => path.join(tmpRoot, `${name}.sqlite`)

const probeMemory = new SQLiteChatMemory({ dbPath: createDbPath('probe') })
const sqliteAvailable = probeMemory.isAvailable()

const describeSQLite = sqliteAvailable ? describe : describe.skip

describeSQLite('PersistentMessageManager with SQLiteChatMemory', () => {
  it('persists and restores conversation history', () => {
    const conversationId = 'persist-case'
    const dbPath = createDbPath(conversationId)
    const memory = new SQLiteChatMemory({ dbPath })
    const manager = new PersistentMessageManager({ memory, conversationId })

    manager.addSystem('System prompt')
    manager.addHuman('Hello world')
    manager.addAI('Hi there!')

    const stored = memory.getMessages(conversationId)
    expect(stored.length).toBe(3)

    const reloadedMemory = new SQLiteChatMemory({ dbPath })
    const restoredManager = new PersistentMessageManager({ memory: reloadedMemory, conversationId })
    const restoredMessages = restoredManager.getMessages()

    expect(restoredMessages.length).toBe(3)
    expect(restoredMessages[0]._getType()).toBe('system')
    expect(restoredMessages[1]._getType()).toBe('human')
    expect(restoredMessages[2]._getType()).toBe('ai')
  })

  it('clears persisted history when cleared', () => {
    const conversationId = 'clear-case'
    const dbPath = createDbPath(conversationId)
    const memory = new SQLiteChatMemory({ dbPath })
    const manager = new PersistentMessageManager({ memory, conversationId })

    manager.addHuman('Test message')
    expect(memory.getMessages(conversationId).length).toBe(1)

    manager.clear()
    expect(memory.getMessages(conversationId).length).toBe(0)
  })
})

if (!sqliteAvailable) {
  it('falls back to in-memory storage when SQLite is unavailable', () => {
    const manager = new PersistentMessageManager({ conversationId: 'fallback-case' })
    manager.addHuman('Fallback message')
    expect(manager.getMessages().length).toBe(1)

    manager.clear()
    expect(manager.getMessages().length).toBe(0)
  })
}
