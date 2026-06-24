/**
 * DEC private-mode tracking for replayed terminal streams.
 *
 * THE BUG THIS FIXES: a kept-alive direct pty (FIX GG) replays only the LAST 200KB of its
 * buffered output when the operator reopens the terminal. tmux (and any TUI) enables mouse
 * tracking / alt-screen / bracketed-paste with DECSET sequences (\x1b[?1000h …) ONCE, at the
 * very HEAD of the stream — so once a session has produced >200KB, the replayed tail no longer
 * contains them and the fresh xterm never enters mouse mode → the wheel sends nothing → the
 * terminal "can't scroll". (Maximizing "fixed" it only because a REAL size change makes tmux
 * fully redraw and re-assert its modes; a same-size reopen emits nothing.)
 *
 * THE FIX: watch the outgoing byte stream for DECSET/DECRST of the modes that define terminal
 * UX state, remember the latest value of each, and prepend a re-assert prefix to any buffer
 * replay. This replays exactly what the inner application itself asserted — correct for both
 * the tmux-wrapped path and a raw `claude --resume` pty (no forged state: untouched modes are
 * simply not emitted).
 */

/** Modes worth re-asserting, in emit order. 1049 (alt screen) goes FIRST so the replayed
 *  content lands in the right buffer; the rest are order-independent:
 *  1 cursor keys app mode · 25 cursor visibility · 1000/1002/1003 mouse tracking ·
 *  1004 focus events · 1005/1006 mouse encodings · 2004 bracketed paste. */
const REPLAY_MODES = [1049, 1, 25, 1000, 1002, 1003, 1004, 1005, 1006, 2004];

const DECSET_RE = /\x1b\[\?([0-9;]+)([hl])/g;

/** Tracks the latest DECSET/DECRST state across arbitrarily-chunked stream data.
 *  Chunk boundaries can split an escape sequence, so a small tail of the previous chunk is
 *  re-scanned with the next one — re-seeing a complete sequence is harmless (idempotent set). */
export class TermModeTracker {
  private state = new Map<number, boolean>();
  private carry = "";

  feed(chunk: string): void {
    const data = this.carry + chunk;
    DECSET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DECSET_RE.exec(data))) {
      const on = m[2] === "h";
      for (const p of m[1].split(";")) {
        const n = parseInt(p, 10);
        if (REPLAY_MODES.includes(n)) this.state.set(n, on);
      }
    }
    // longest sequence we care about is ~"\x1b[?1000;1002;1006h"-ish; 24 chars is plenty
    this.carry = data.slice(-24);
  }

  /** Escape string that restores every tracked mode to its latest observed value. */
  reassertPrefix(): string {
    let out = "";
    for (const n of REPLAY_MODES) {
      const v = this.state.get(n);
      if (v === undefined) continue;
      out += `\x1b[?${n}${v ? "h" : "l"}`;
    }
    return out;
  }
}
