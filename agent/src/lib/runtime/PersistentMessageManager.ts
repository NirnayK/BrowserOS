import { MessageManager, MessageType, BrowserStateMessage, TodoListMessage } from '@/lib/runtime/MessageManager'
import { Logging } from '@/lib/utils/Logging'
import {
  ChatMemoryAdapter,
  ChatMemoryMessage,
  InMemoryChatMemory,
  SQLiteChatMemory
} from '@/lib/runtime/memory/SQLiteChatMemory'
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from '@langchain/core/messages'

interface PersistentMessageManagerOptions {
  maxTokens?: number
  conversationId?: string
  dbPath?: string
  memory?: ChatMemoryAdapter
}

interface SerializedContent {
  content: string
  isJson: boolean
}

export class PersistentMessageManager extends MessageManager {
  private readonly memory: ChatMemoryAdapter
  private readonly conversationId: string
  private restoring = false

  constructor(options: PersistentMessageManagerOptions = {}) {
    super(options.maxTokens)

    const envConversationId = typeof process !== 'undefined' ? process.env?.BROWSEROS_CHAT_MEMORY_ID : undefined
    this.conversationId = options.conversationId ?? envConversationId ?? 'default'

    this.memory = this.initializeMemory(options)
    this.restoreFromMemory()
  }

  override add(message: BaseMessage, position?: number): void {
    super.add(message, position)
    if (!this.restoring) {
      this.persistMessages()
    }
  }

  override clear(): void {
    super.clear()
    if (!this.restoring) {
      try {
        this.memory.clearConversation(this.conversationId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        Logging.log('PersistentMessageManager', `Failed to clear stored conversation: ${message}`, 'warning')
      }
    }
  }

  override removeLast(): boolean {
    const removed = super.removeLast()
    if (removed && !this.restoring) {
      this.persistMessages()
    }
    return removed
  }

  override setMaxTokens(newMaxTokens: number): void {
    super.setMaxTokens(newMaxTokens)
    if (!this.restoring) {
      this.persistMessages()
    }
  }

  private initializeMemory(options: PersistentMessageManagerOptions): ChatMemoryAdapter {
    if (options.memory) {
      try {
        options.memory.initialize()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        Logging.log('PersistentMessageManager', `Failed to initialize provided chat memory: ${message}`, 'warning')
      }
      if (options.memory.isAvailable()) {
        return options.memory
      }

      Logging.log('PersistentMessageManager', 'Provided chat memory is unavailable - using fallback', 'warning')
      return this.createFallbackMemory()
    }

    const sqliteMemory = new SQLiteChatMemory({ dbPath: options.dbPath })
    sqliteMemory.initialize()

    if (sqliteMemory.isAvailable()) {
      return sqliteMemory
    }

    Logging.log('PersistentMessageManager', 'SQLite chat memory unavailable - using in-memory fallback', 'warning')
    return this.createFallbackMemory()
  }

  private createFallbackMemory(): ChatMemoryAdapter {
    const fallback = new InMemoryChatMemory()
    fallback.initialize()
    return fallback
  }

  private restoreFromMemory(): void {
    try {
      const storedMessages = this.memory.getMessages(this.conversationId)
      if (storedMessages.length === 0) {
        return
      }

      this.restoring = true
      for (const stored of storedMessages) {
        const message = this.deserializeMessage(stored)
        super.add(message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logging.log('PersistentMessageManager', `Failed to restore chat history: ${message}`, 'warning')
    } finally {
      this.restoring = false
    }
  }

  private persistMessages(): void {
    try {
      const messages = this.getMessages().map((message, index) => this.serializeMessage(message, index))
      this.memory.replaceConversation(this.conversationId, messages)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logging.log('PersistentMessageManager', `Failed to persist chat history: ${message}`, 'warning')
    }
  }

  private serializeMessage(message: BaseMessage, sequence: number): ChatMemoryMessage {
    const serialized = this.normalizeContent(message)
    const metadata = this.extractMetadata(message, serialized.isJson)

    const record: ChatMemoryMessage = {
      role: this._getMessageType(message),
      content: serialized.content,
      sequence,
      createdAt: Date.now()
    }

    if (metadata) {
      record.metadata = metadata
    }

    return record
  }

  private normalizeContent(message: BaseMessage): SerializedContent {
    const rawContent = message.content
    if (typeof rawContent === 'string') {
      return { content: rawContent, isJson: false }
    }

    try {
      return { content: JSON.stringify(rawContent), isJson: true }
    } catch {
      return { content: String(rawContent), isJson: false }
    }
  }

  private extractMetadata(message: BaseMessage, contentIsJson: boolean): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {}

    if (contentIsJson) {
      metadata.contentIsJson = true
    }

    if (message.additional_kwargs && Object.keys(message.additional_kwargs).length > 0) {
      metadata.additional_kwargs = message.additional_kwargs
    }

    if (message instanceof ToolMessage) {
      const toolMessage = message as ToolMessage
      metadata.toolCallId = toolMessage.tool_call_id

      if (toolMessage.status) {
        metadata.toolStatus = toolMessage.status
      }

      if (toolMessage.artifact !== undefined) {
        metadata.artifact = toolMessage.artifact
      }

      if (toolMessage.metadata && Object.keys(toolMessage.metadata).length > 0) {
        metadata.toolMetadata = toolMessage.metadata
      }
    }

    if (message instanceof AIMessage) {
      const aiMessage = message as AIMessage

      if (Array.isArray(aiMessage.tool_calls) && aiMessage.tool_calls.length > 0) {
        metadata.toolCalls = aiMessage.tool_calls
      }

      const invalidCalls = (aiMessage as any).invalid_tool_calls
      if (Array.isArray(invalidCalls) && invalidCalls.length > 0) {
        metadata.invalidToolCalls = invalidCalls
      }

      if (aiMessage.usage_metadata) {
        metadata.usageMetadata = aiMessage.usage_metadata
      }
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined
  }

  private deserializeMessage(record: ChatMemoryMessage): BaseMessage {
    const content = this.restoreContent(record)
    const metadata = record.metadata ?? {}

    switch (record.role) {
      case MessageType.SYSTEM:
        return new SystemMessage(content)
      case MessageType.HUMAN:
        return new HumanMessage(content)
      case MessageType.TOOL: {
        const toolFields: any = {
          content,
          tool_call_id: typeof metadata.toolCallId === 'string' ? metadata.toolCallId : ''
        }

        if (typeof metadata.toolStatus === 'string') {
          toolFields.status = metadata.toolStatus
        }

        if (metadata.artifact !== undefined) {
          toolFields.artifact = metadata.artifact
        }

        if (metadata.toolMetadata && typeof metadata.toolMetadata === 'object') {
          toolFields.metadata = metadata.toolMetadata
        }

        if (metadata.additional_kwargs && typeof metadata.additional_kwargs === 'object') {
          toolFields.additional_kwargs = metadata.additional_kwargs
        }

        return new ToolMessage(toolFields)
      }
      case MessageType.BROWSER_STATE:
        return new BrowserStateMessage(typeof content === 'string' ? content : JSON.stringify(content))
      case MessageType.TODO_LIST:
        return new TodoListMessage(typeof content === 'string' ? content : JSON.stringify(content))
      case MessageType.AI:
      default: {
        const fields: Record<string, unknown> = { content }

        if (Array.isArray(metadata.toolCalls)) {
          fields.tool_calls = metadata.toolCalls
        }

        if (Array.isArray(metadata.invalidToolCalls)) {
          fields.invalid_tool_calls = metadata.invalidToolCalls
        }

        if (metadata.additional_kwargs && typeof metadata.additional_kwargs === 'object') {
          fields.additional_kwargs = metadata.additional_kwargs
        }

        if (metadata.usageMetadata && typeof metadata.usageMetadata === 'object') {
          fields.usage_metadata = metadata.usageMetadata
        }

        return new AIMessage(fields)
      }
    }
  }

  private restoreContent(record: ChatMemoryMessage): any {
    if (record.metadata?.contentIsJson && record.content) {
      try {
        return JSON.parse(record.content)
      } catch {
        return record.content
      }
    }

    return record.content
  }
}
