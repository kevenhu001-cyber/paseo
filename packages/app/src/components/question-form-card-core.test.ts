import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormQuestionsFromActions,
  buildQuestionFormAnswers,
  mergeQuestionsWithActionFallback,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-card-core";

describe("question form card core", () => {
  test("normalizes common ACP option shapes instead of dropping the question", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick a mode",
          header: "Mode",
          options: [
            "Fast",
            { title: "Accurate", description: "More deliberate" },
            { name: "Balanced" },
            { const: "Custom" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        question: "Pick a mode",
        header: "Mode",
        options: [
          { label: "Fast" },
          { label: "Accurate", description: "More deliberate" },
          { label: "Balanced", description: undefined },
          { label: "Custom", description: undefined },
        ],
        multiSelect: false,
        allowOther: false,
        allowEmpty: false,
        placeholder: undefined,
        dismissLabel: undefined,
      },
    ]);
  });

  test("builds a visible choice form when a question payload is missing", () => {
    expect(
      buildQuestionFormQuestionsFromActions(
        [
          { behavior: "allow", label: "Continue" },
          { behavior: "deny", label: "Cancel" },
        ],
        "What should happen next?",
      ),
    ).toEqual([
      {
        question: "What should happen next?",
        header: "Response",
        options: [{ label: "Continue" }],
        multiSelect: false,
        allowOther: false,
        allowEmpty: false,
      },
    ]);
  });

  test("treats optional input prompts as skippable empty answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Optional comment?",
          header: "Response",
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
          dismissLabel: "Skip",
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(areQuestionsAnswered(questions, {}, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, {})).toEqual({ Response: "" });
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(resolveDismissLabel(questions)).toBe("Skip");
  });

  test("requires a selection for option-only questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick one",
          header: "Response",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(false);
    expect(areQuestionsAnswered(questions, {}, { 0: "freeform" })).toBe(false);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]) }, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Response: "B",
    });
  });

  test("allows optional option-only questions to submit without a selection", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Optional choice",
          header: "Choice",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
          allowEmpty: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(areQuestionsAnswered(questions, {}, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, {})).toEqual({});
  });

  test("shows text input for explicit other questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          isOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("shows text input for questions that allow other answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          allowOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  describe("mergeQuestionsWithActionFallback", () => {
    test("borrows action labels for a single question whose options were dropped", () => {
      const parsed = parseQuestionFormQuestions({
        questions: [
          {
            question: "Which path?",
            header: "Path",
            options: [],
          },
        ],
      });
      const fallback = buildQuestionFormQuestionsFromActions(
        [
          { behavior: "allow", label: "Narrow fix" },
          { behavior: "allow", label: "Protocol fix" },
          { behavior: "deny", label: "Skip" },
        ],
        "Which path?",
      );

      const merged = mergeQuestionsWithActionFallback(parsed, fallback);

      expect(merged).toEqual([
        {
          question: "Which path?",
          header: "Path",
          options: [{ label: "Narrow fix" }, { label: "Protocol fix" }],
          multiSelect: false,
          allowOther: false,
          allowEmpty: false,
          placeholder: undefined,
          dismissLabel: undefined,
        },
      ]);
    });

    test("fills optionless questions while keeping questions that already have options", () => {
      const parsed = parseQuestionFormQuestions({
        questions: [
          {
            question: "Pick one",
            header: "Mode",
            options: [{ label: "Default" }],
          },
          {
            question: "Now pick the path",
            header: "Path",
            options: [],
          },
        ],
      });
      const fallback = buildQuestionFormQuestionsFromActions(
        [
          { behavior: "allow", label: "Narrow fix" },
          { behavior: "allow", label: "Protocol fix" },
        ],
        "Now pick the path",
      );

      const merged = mergeQuestionsWithActionFallback(parsed, fallback);

      expect(merged?.[0]?.options).toEqual([{ label: "Default" }]);
      expect(merged?.[1]?.options).toEqual([{ label: "Narrow fix" }, { label: "Protocol fix" }]);
    });

    test("returns the parsed questions unchanged when the fallback has no options", () => {
      const parsed = parseQuestionFormQuestions({
        questions: [
          {
            question: "Free text",
            header: "Response",
            options: [],
          },
        ],
      });
      const fallback = buildQuestionFormQuestionsFromActions([], "Free text");

      const merged = mergeQuestionsWithActionFallback(parsed, fallback);

      expect(merged).toEqual(parsed);
    });

    test("uses the fallback outright when parsing produced nothing", () => {
      const fallback = buildQuestionFormQuestionsFromActions(
        [{ behavior: "allow", label: "Yes" }],
        "Continue?",
      );

      const merged = mergeQuestionsWithActionFallback(null, fallback);

      expect(merged).toEqual(fallback);
    });
  });
});
