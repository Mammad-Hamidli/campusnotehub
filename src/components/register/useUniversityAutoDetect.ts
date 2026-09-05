'use client';

import { useCallback, useRef, useState } from 'react';
import { detectUniversityFromEmail } from '@/lib/universities';

export type AutoDetectState =
  | { status: 'idle' }
  /** Auto-filled from the email domain and not yet touched by the user. */
  | { status: 'detected'; universityId: string }
  /** The user changed it by hand; we stop overwriting from here on. */
  | { status: 'overridden' };

/**
 * Auto-selects a university from the email domain, without ever fighting the
 * user for control of the field.
 *
 * The rule that makes this feel helpful rather than possessed:
 *
 *   Auto-fill only while the field is EMPTY or still holds a value we put
 *   there ourselves. The moment the user picks a university by hand, we stop
 *   touching it — permanently, for the rest of the session.
 *
 * Without that latch, the obvious implementation produces a genuinely broken
 * form: a student on a personal Gmail picks "UNEC" manually, then goes back to
 * fix a typo in their email, and the university silently resets. They submit
 * the wrong institution and only find out when verification fails against a
 * student card that does not match.
 *
 * Clearing the email does not clear a detected university either. If the value
 * was right, wiping it while someone edits their address is just destructive.
 */
export function useUniversityAutoDetect({
  onDetect,
}: {
  /** Called only when the hook actually wants to change the selection. */
  onDetect: (universityId: string) => void;
}) {
  const [state, setState] = useState<AutoDetectState>({ status: 'idle' });

  // A ref, not state: the handler below must read the CURRENT value, and a
  // stale closure over state would let one keystroke overwrite a manual pick.
  const overriddenRef = useRef(false);

  /** Call from the email field's onChange, with the new email value. */
  const handleEmailChange = useCallback(
    (email: string) => {
      if (overriddenRef.current) return;

      const detected = detectUniversityFromEmail(email);
      if (!detected) return; // unknown or incomplete domain - leave it alone

      setState((prev) => {
        if (prev.status === 'detected' && prev.universityId === detected) return prev;
        return { status: 'detected', universityId: detected };
      });
      onDetect(detected);
    },
    [onDetect],
  );

  /** Call from the university select's onChange. Latches the override. */
  const handleManualChange = useCallback(() => {
    overriddenRef.current = true;
    setState({ status: 'overridden' });
  }, []);

  /** Lets the user undo a manual override and go back to following the email. */
  const resetOverride = useCallback(() => {
    overriddenRef.current = false;
    setState({ status: 'idle' });
  }, []);

  return {
    state,
    handleEmailChange,
    handleManualChange,
    resetOverride,
    /** True when the current selection came from the email domain. */
    wasAutoDetected: state.status === 'detected',
  };
}
