export type AgentType = 'opencode' | 'pydantic' | 'codex' | 'claude_code'
export type PydanticSchemaId = 'structured_response_v1'

export interface SupportedModelOption {
  label: string
  value: string
}

export const MODEL_OPTIONS = {
  claudeSonnet46: { label: 'Claude Sonnet 4.6', value: 'anthropic/claude-sonnet-4-6' },
  claudeOpus46: { label: 'Claude Opus 4.6', value: 'anthropic/claude-opus-4-6' },
  claudeHaiku45: { label: 'Claude Haiku 4.5', value: 'anthropic/claude-haiku-4-5' },
  gpt4o: { label: 'GPT-4o', value: 'openai/gpt-4o' },
  gpt4oMini: { label: 'GPT-4o Mini', value: 'openai/gpt-4o-mini' },
  o3Mini: { label: 'o3 Mini', value: 'openai/o3-mini' },
  codex52: { label: 'GPT-5.2 Codex', value: 'openai/gpt-5.2-codex' },
  codex53: { label: 'GPT-5.3 Codex', value: 'openai/gpt-5.3-codex' },
  gemini25Pro: { label: 'Gemini 2.5 Pro', value: 'google/gemini-2.5-pro' },
  gemini25Flash: { label: 'Gemini 2.5 Flash', value: 'google/gemini-2.5-flash' },
} satisfies Record<string, SupportedModelOption>

export const ALL_SUPPORTED_MODELS: SupportedModelOption[] = [
  MODEL_OPTIONS.claudeSonnet46,
  MODEL_OPTIONS.claudeOpus46,
  MODEL_OPTIONS.claudeHaiku45,
  MODEL_OPTIONS.gpt4o,
  MODEL_OPTIONS.gpt4oMini,
  MODEL_OPTIONS.o3Mini,
  MODEL_OPTIONS.codex52,
  MODEL_OPTIONS.codex53,
  MODEL_OPTIONS.gemini25Pro,
  MODEL_OPTIONS.gemini25Flash,
]

export const SUPPORTED_MODELS_BY_AGENT_TYPE: Record<AgentType, SupportedModelOption[]> = {
  opencode: [
    MODEL_OPTIONS.claudeSonnet46,
    MODEL_OPTIONS.claudeOpus46,
    MODEL_OPTIONS.claudeHaiku45,
    MODEL_OPTIONS.gpt4o,
    MODEL_OPTIONS.gpt4oMini,
    MODEL_OPTIONS.o3Mini,
  ],
  pydantic: [
    MODEL_OPTIONS.claudeSonnet46,
    MODEL_OPTIONS.claudeOpus46,
    MODEL_OPTIONS.claudeHaiku45,
    MODEL_OPTIONS.gpt4o,
    MODEL_OPTIONS.gpt4oMini,
    MODEL_OPTIONS.o3Mini,
    MODEL_OPTIONS.gemini25Pro,
    MODEL_OPTIONS.gemini25Flash,
  ],
  codex: [
    MODEL_OPTIONS.codex52,
    MODEL_OPTIONS.codex53,
  ],
  claude_code: [
    MODEL_OPTIONS.claudeSonnet46,
    MODEL_OPTIONS.claudeOpus46,
    MODEL_OPTIONS.claudeHaiku45,
  ],
}

export const PYDANTIC_SCHEMA_OPTIONS: { label: string; value: PydanticSchemaId }[] = [
  { label: 'Structured Response v1', value: 'structured_response_v1' },
]

export const DEFAULT_MODEL_BY_AGENT_TYPE: Record<AgentType, string> = {
  opencode: 'anthropic/claude-sonnet-4-6',
  pydantic: 'google/gemini-2.5-pro',
  codex: 'openai/gpt-5.3-codex',
  claude_code: 'anthropic/claude-sonnet-4-6',
}
