export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionFormQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export type QuestionSelections = Record<number, ReadonlySet<number>>;
export type QuestionOtherTexts = Record<number, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readDisplayString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readFirstDisplayString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readDisplayString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseQuestionOption(value: unknown): QuestionOption | null {
  const label = readDisplayString(value);
  if (label) {
    return { label };
  }
  if (!isRecord(value)) {
    return null;
  }

  const optionLabel = readFirstDisplayString(value, ["label", "title", "name", "value", "const"]);
  if (!optionLabel) {
    return null;
  }
  return {
    label: optionLabel,
    description: readOptionalString(value, "description"),
  };
}

export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return null;
  }
  const raw = input.questions;
  const questions: QuestionFormQuestion[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }

    const question = readFirstDisplayString(item, ["question", "prompt", "text", "title"]);
    if (!question) {
      continue;
    }
    const header = readFirstDisplayString(item, ["header", "name", "id"]) ?? question;
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => parseQuestionOption(option))
          .filter((option): option is QuestionOption => option !== null)
      : [];

    questions.push({
      question,
      header,
      options,
      multiSelect: item.multiSelect === true || item.multiple === true,
      allowOther: item.allowOther === true || item.isOther === true || item.allow_other === true,
      allowEmpty: item.allowEmpty === true || item.optional === true,
      placeholder: readOptionalString(item, "placeholder"),
      dismissLabel: readOptionalString(item, "dismissLabel"),
    });
  }
  return questions.length > 0 ? questions : null;
}

export function buildQuestionFormQuestionsFromActions(
  actions: readonly { behavior?: string; label?: string }[] | undefined,
  question = "Choose an option",
): QuestionFormQuestion[] | null {
  const options = (actions ?? [])
    .filter((action) => action.behavior === "allow" && typeof action.label === "string")
    .map((action) => ({ label: action.label?.trim() ?? "" }))
    .filter((option) => option.label.length > 0);
  if (options.length === 0) {
    return null;
  }
  return [
    {
      question,
      header: "Response",
      options,
      multiSelect: false,
      allowOther: false,
      allowEmpty: false,
    },
  ];
}

/**
 * Merges parsed questions with action-derived options so a chooser request
 * never ends up with a question that has no buttons. When a provider drops
 * the form options while serializing the request, we keep the question's
 * original text and headers but borrow the action labels as the choice
 * list. Any question that already has options is left untouched.
 */
export function mergeQuestionsWithActionFallback(
  parsed: QuestionFormQuestion[] | null,
  fallback: QuestionFormQuestion[] | null,
): QuestionFormQuestion[] | null {
  if (!fallback) {
    return parsed;
  }
  if (!parsed) {
    return fallback;
  }
  return parsed.map((question, index) => {
    if (question.options.length > 0) {
      return question;
    }
    const fallbackQuestion = fallback[index] ?? fallback[0];
    if (!fallbackQuestion || fallbackQuestion.options.length === 0) {
      return question;
    }
    return { ...question, options: fallbackQuestion.options, allowOther: false };
  });
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  qIndex: number,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  const selected = selections[qIndex];
  if (selected && selected.size > 0) {
    return true;
  }

  if (!questionShowsTextInput(question)) {
    return question.allowEmpty;
  }

  const otherText = otherTexts[qIndex]?.trim();
  if (otherText && otherText.length > 0) {
    return true;
  }

  return question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: QuestionFormQuestion[] | null,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions?.every((question, qIndex) =>
      isQuestionAnswered(question, qIndex, selections, otherTexts),
    ) ?? false
  );
}

export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections[i];
    const otherText = otherTexts[i]?.trim();

    if (questionShowsTextInput(q)) {
      if (otherText && otherText.length > 0) {
        answers[q.header] = otherText;
        continue;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[q.header] = "";
        continue;
      }
    }

    if (selected && selected.size > 0) {
      const labels = Array.from(selected).map((idx) => q.options[idx].label);
      answers[q.header] = labels.join(", ");
    }
  }
  return answers;
}

export function shouldSubmitEmptyOnDismiss(questions: QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.options.length === 0)
  );
}

export function resolveDismissLabel(
  questions: QuestionFormQuestion[],
  fallbackLabel = "Dismiss",
): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallbackLabel;
}
