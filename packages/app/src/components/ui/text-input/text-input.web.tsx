import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { TextInput } from "react-native";
import type { EditingTextInputHandle, EditingTextInputProps } from "./types";

type WebTextInputElement = HTMLElement &
  TextInput & {
    value?: string;
    setSelectionRange?: (start: number, end: number) => void;
  };

export const EditingTextInput = forwardRef<EditingTextInputHandle, EditingTextInputProps>(
  function EditingTextInputWeb(allProps, ref) {
    const {
      initialValue = "",
      onChangeText,
      onPasteImages: _,
      onPasteError: __,
      variant: ___,
      value: ____,
      defaultValue: _____,
      ...props
    } = allProps as EditingTextInputProps & { value?: unknown; defaultValue?: unknown };
    const inputRef = useRef<TextInput | null>(null);
    const initialTextRef = useRef(initialValue);
    const textRef = useRef(initialTextRef.current);
    const isComposingRef = useRef(false);
    const onChangeTextRef = useRef(onChangeText);
    onChangeTextRef.current = onChangeText;

    useEffect(() => {
      const input = inputRef.current as WebTextInputElement | null;
      if (!input) return;

      const startComposition = () => {
        isComposingRef.current = true;
      };
      const endComposition = () => {
        isComposingRef.current = false;
        const nextText = input.value ?? "";
        if (nextText === textRef.current) return;
        textRef.current = nextText;
        onChangeTextRef.current?.(nextText);
      };

      const handleFocus = () => {
        if (typeof window !== "undefined" && (window.scrollY !== 0 || window.scrollX !== 0)) {
          window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        }
      };

      input.addEventListener("compositionstart", startComposition);
      input.addEventListener("compositionend", endComposition);
      input.addEventListener("focus", handleFocus, { passive: true });
      return () => {
        input.removeEventListener("compositionstart", startComposition);
        input.removeEventListener("compositionend", endComposition);
        input.removeEventListener("focus", handleFocus);
      };
    }, []);

    const handleChangeText = useCallback((nextText: string) => {
      if (isComposingRef.current || nextText === textRef.current) return;
      textRef.current = nextText;
      onChangeTextRef.current?.(nextText);
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => {
        const input = inputRef.current as unknown as HTMLElement | null;
        if (input && typeof input.focus === "function") {
          try {
            input.focus({ preventScroll: true });
            return;
          } catch {
            // Fallback for environments where preventScroll option is unsupported
          }
        }
        inputRef.current?.focus();
      },
      blur: () => inputRef.current?.blur(),
      isFocused: () => document.activeElement === inputRef.current,
      getText: () => {
        const input = inputRef.current as WebTextInputElement | null;
        const nextText = input?.value ?? textRef.current;
        textRef.current = nextText;
        return nextText;
      },
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        const input = inputRef.current as WebTextInputElement | null;
        if (input && "value" in input) input.value = nextText;
        if (selection && typeof input?.setSelectionRange === "function") {
          input.setSelectionRange(selection.start, selection.end);
        }
      },
      reset: () => {
        textRef.current = "";
        const input = inputRef.current as WebTextInputElement | null;
        if (input && "value" in input) input.value = "";
      },
      getNativeRef: () => inputRef.current,
    }));

    return (
      <TextInput
        {...props}
        ref={inputRef}
        defaultValue={initialTextRef.current}
        onChangeText={handleChangeText}
      />
    );
  },
);
