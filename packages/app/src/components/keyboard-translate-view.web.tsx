import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { View, type ViewProps, type ViewStyle } from "react-native";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
}

const GPU_ACCELERATED_TRANSITION_STYLE: ViewStyle = {
  // @ts-ignore - Web CSS properties for hardware-accelerated keyboard transition
  transitionProperty: "transform",
  transitionDuration: "280ms",
  transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
  willChange: "transform",
};

/**
 * Web implementation of KeyboardTranslateView.
 * Uses window.visualViewport to detect virtual keyboard appearance on mobile browsers,
 * applies a smooth hardware-accelerated CSS transition to rise continuously with the keyboard,
 * and prevents native scroll jumps that cause instant snapping and jitter.
 *
 * Uses direct DOM manipulation to update the transform so that the entire chat stream
 * and virtualized list do not trigger costly React re-renders during keyboard presentation.
 */
export function KeyboardTranslateView({
  children,
  enabled = true,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const containerRef = useRef<View | null>(null);
  const currentShiftRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Apply transform directly to the DOM element to keep keyboard animation
  // completely off the React reconciliation pipeline (no chat re-renders).
  const applyTransform = (shift: number) => {
    currentShiftRef.current = shift;
    const el = containerRef.current as unknown as HTMLElement | null;
    if (!el) return;

    const activeShift = enabledRef.current ? shift : 0;
    el.style.transform =
      activeShift > 0 ? `translate3d(0, -${activeShift}px, 0)` : "translate3d(0, 0, 0)";
  };

  useLayoutEffect(() => {
    applyTransform(currentShiftRef.current);
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) {
      return;
    }
    const viewport = window.visualViewport;

    const enforceScrollAnchor = () => {
      // Prevent browser's native focus scroll from knocking the fixed full-height app shell out of place
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      }
    };

    let rafId: number | null = null;
    const update = () => {
      enforceScrollAnchor();

      // Compute visible keyboard displacement from visual viewport metrics
      const rawOffset = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - (viewport.offsetTop || 0)),
      );
      // Suppress subpixel or address bar micro-fluctuations (< 10px)
      const nextShift = rawOffset < 10 ? 0 : rawOffset;

      if (nextShift !== currentShiftRef.current) {
        applyTransform(nextShift);
      }
    };

    const scheduleUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    const handleFocusIn = () => {
      enforceScrollAnchor();
      scheduleUpdate();
    };

    viewport.addEventListener("resize", scheduleUpdate);
    viewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("scroll", enforceScrollAnchor, { passive: true });
    window.addEventListener("focusin", handleFocusIn, { passive: true });
    window.addEventListener("focusout", scheduleUpdate, { passive: true });

    // Initial check in case viewport is already constrained
    scheduleUpdate();

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      viewport.removeEventListener("resize", scheduleUpdate);
      viewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("scroll", enforceScrollAnchor);
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", scheduleUpdate);
    };
  }, []);

  return (
    <View
      ref={containerRef}
      style={[
        style,
        GPU_ACCELERATED_TRANSITION_STYLE,
        { transform: [{ translateY: enabled ? -currentShiftRef.current : 0 }] },
      ]}
      {...props}
    >
      {children}
    </View>
  );
}
