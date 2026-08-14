import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormQuestionsFromActions,
  buildQuestionFormAnswers,
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
});
