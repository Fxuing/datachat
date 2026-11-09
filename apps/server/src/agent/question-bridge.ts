import { randomUUID } from "node:crypto";
import type { EventBus, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * Channel contract of `@juicesharp/rpiv-ask-user-question` (see its `events.ts`).
 * Kept as literals so the server does not depend on the package's TS source types.
 */
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer";
const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result";

export interface AskUserQuestionOption {
  label: string;
  description: string;
  hasPreview: boolean;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserPrompt {
  toolCallId: string;
  questions: AskUserQuestion[];
}

export interface AskUserAnswerEntry {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
  notes?: string;
}

export interface AskUserAnswerInput {
  answers?: AskUserAnswerEntry[];
  globalNote?: string;
  cancel?: boolean;
}

export interface AskUserAnswerVerdict {
  toolCallId: string;
  ok: boolean;
  code?: string;
  reason?: string;
}

interface QuestionBridgeOptions {
  onQuestion: (prompt: AskUserPrompt) => void;
  onResolved: (verdict: AskUserAnswerVerdict) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQuestion(value: unknown): AskUserQuestion | undefined {
  if (!isRecord(value) || typeof value.question !== "string") return undefined;
  const options = Array.isArray(value.options)
    ? value.options
        .filter(isRecord)
        .filter((option) => typeof option.label === "string")
        .map((option) => ({
          label: option.label as string,
          description: typeof option.description === "string" ? option.description : "",
          hasPreview: option.hasPreview === true,
        }))
    : [];
  return {
    question: value.question,
    header: typeof value.header === "string" ? value.header : "",
    multiSelect: value.multiSelect === true,
    options,
  };
}

/** The plugin only inspects the TUI while mounting; the web host answers via events. */
const stubTui = {
  terminal: { width: 120, height: 40, rows: 40, columns: 120 },
  requestRender() {},
  hasOverlay: () => false,
  getTopmostVisibleOverlay: () => undefined,
} as never;

const stubTheme = new Proxy(
  {},
  {
    get: () => (key: string, text?: string) =>
      typeof text === "string" ? text : typeof key === "string" ? "" : "",
  },
) as never;

const stubKeybindings = new Proxy({}, { get: () => () => false }) as never;

/**
 * Bridges an rpiv questionnaire into the web client.
 *
 * The extension opens questionnaires through `ctx.ui.custom`, which this host
 * implements without rendering: the mount is only needed so the questionnaire
 * accepts answers, and every keystroke path is replaced by the plugin's public
 * `rpiv:ask-user:answer` event.
 */
export class QuestionBridge {
  readonly uiContext: ExtensionUIContext;

  private events: EventBus | undefined;
  private readonly open = new Map<string, AskUserPrompt>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly options: QuestionBridgeOptions) {
    this.uiContext = {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: <T,>(factory: Parameters<ExtensionUIContext["custom"]>[0], _options?: unknown) =>
        new Promise<T>((resolve) => {
          const done = (result: unknown) => resolve(result as T);
          try {
            const component = factory(stubTui, stubTheme, stubKeybindings, done);
            if (component instanceof Promise) void component.catch(() => undefined);
          } catch {
            // Keep the promise pending. The questionnaire can still be settled
            // through `answeredEarly` when the user submits from the browser.
          }
        }),
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: stubTheme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "主题由 Web 客户端控制" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  /** Subscribe to the extension's bus after the Pi session has been created. */
  bind(events: EventBus): void {
    this.dispose();
    this.events = events;

    this.unsubscribers.push(
      events.on(ASK_USER_PROMPT_EVENT, (data: unknown) => {
        if (!isRecord(data) || typeof data.toolCallId !== "string") return;
        if (!Array.isArray(data.questions)) return;
        const questions = data.questions
          .map(parseQuestion)
          .filter((question): question is AskUserQuestion => question !== undefined);
        if (questions.length === 0) return;
        const prompt: AskUserPrompt = { toolCallId: data.toolCallId, questions };
        this.open.set(prompt.toolCallId, prompt);
        this.options.onQuestion(prompt);
      }),
    );

    this.unsubscribers.push(
      events.on(ASK_USER_ANSWER_RESULT_EVENT, (data: unknown) => {
        if (!isRecord(data) || typeof data.toolCallId !== "string") return;
        const verdict: AskUserAnswerVerdict = {
          toolCallId: data.toolCallId,
          ok: data.ok === true,
          ...(typeof data.code === "string" ? { code: data.code } : {}),
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
        };
        if (verdict.ok) this.open.delete(verdict.toolCallId);
        this.options.onResolved(verdict);
      }),
    );
  }

  get(toolCallId: string): AskUserPrompt | undefined {
    return this.open.get(toolCallId);
  }

  /** Drop questionnaires that can no longer be answered (run ended, session replaced). */
  clear(): void {
    this.open.clear();
  }

  /**
   * Send an answer through the extension's channel. The plugin validates it and
   * emits a verdict synchronously, so the caller can report success right away.
   */
  answer(toolCallId: string, input: AskUserAnswerInput): AskUserAnswerVerdict {
    const events = this.events;
    if (!events) {
      return { toolCallId, ok: false, code: "not_found", reason: "会话尚未连接" };
    }
    if (!this.open.has(toolCallId)) {
      return { toolCallId, ok: false, code: "not_found", reason: "该问题已结束" };
    }

    const requestId = randomUUID();
    let verdict: AskUserAnswerVerdict | undefined;
    const unsubscribe = events.on(ASK_USER_ANSWER_RESULT_EVENT, (data: unknown) => {
      if (!isRecord(data) || data.requestId !== requestId) return;
      verdict = {
        toolCallId,
        ok: data.ok === true,
        ...(typeof data.code === "string" ? { code: data.code } : {}),
        ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      };
    });

    try {
      events.emit(ASK_USER_ANSWER_EVENT, { ...input, toolCallId, requestId });
    } finally {
      unsubscribe();
    }

    return (
      verdict ?? {
        toolCallId,
        ok: false,
        code: "not_found",
        reason: "插件未返回应答结果",
      }
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.open.clear();
    this.events = undefined;
  }
}
