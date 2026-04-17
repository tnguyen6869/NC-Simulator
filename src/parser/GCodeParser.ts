// ─── G-Code Parser ───────────────────────────────────────────────────────────
// Stateless, line-by-line parser.  Each line produces one GCodeCommand.

export interface GCodeCommand {
  /** 0-based index into the original lines array */
  lineIndex: number;
  /** Raw source text */
  raw: string;

  // Modal group 1 — Motion
  G?: number;   // 0=Rapid, 1=Linear, 2=CW Arc, 3=CCW Arc, 4=Dwell, 28=Home…
  M?: number;   // Machine code

  // Coordinates
  X?: number; Y?: number; Z?: number;
  A?: number; B?: number; C?: number;

  // Arc / dwell parameters
  I?: number; J?: number; K?: number;
  R?: number;  // radius-form arc
  P?: number;  // dwell time / peck

  // Miscellaneous
  F?: number;  // feed rate
  S?: number;  // spindle speed
  T?: number;  // tool number
  H?: number;  // tool length offset
  D?: number;  // cutter radius offset
  N?: number;  // line number (ignored for motion)

  comment?: string;
}

/** Parse a single G-code line. Never throws. */
export function parseLine(raw: string, lineIndex: number): GCodeCommand {
  const cmd: GCodeCommand = { lineIndex, raw };

  let text = raw;

  // ── Strip comments ────────────────────────────────────────────
  // Parenthesised comments  (...)
  text = text.replace(/\(([^)]*)\)/g, (_m, c) => {
    cmd.comment = (cmd.comment ? cmd.comment + ' ' : '') + c.trim();
    return ' ';
  });
  // Semicolon comments  ;...
  const semi = text.indexOf(';');
  if (semi >= 0) {
    const c = text.slice(semi + 1).trim();
    if (c) cmd.comment = (cmd.comment ? cmd.comment + ' ' : '') + c;
    text = text.slice(0, semi);
  }
  // Hash-sign comments  #...
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(0, hash);

  // ── Tokenise ─────────────────────────────────────────────────
  // Each token is a letter followed by an optional sign + number
  const TOKEN = /([A-Za-z])([+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    const letter = m[1].toUpperCase();
    const value  = parseFloat(m[2]);

    switch (letter) {
      case 'G': cmd.G = value; break;
      case 'M': cmd.M = value; break;
      case 'X': cmd.X = value; break;
      case 'Y': cmd.Y = value; break;
      case 'Z': cmd.Z = value; break;
      case 'A': cmd.A = value; break;
      case 'B': cmd.B = value; break;
      case 'C': cmd.C = value; break;
      case 'I': cmd.I = value; break;
      case 'J': cmd.J = value; break;
      case 'K': cmd.K = value; break;
      case 'R': cmd.R = value; break;
      case 'P': cmd.P = value; break;
      case 'F': cmd.F = value; break;
      case 'S': cmd.S = value; break;
      case 'T': cmd.T = value; break;
      case 'H': cmd.H = value; break;
      case 'D': cmd.D = value; break;
      case 'N': cmd.N = value; break;
      // Ignore: E (extruder), L (repeat), O (subprogram)
    }
  }

  return cmd;
}

/** Parse an entire G-code program string into an array of commands. */
export function parseGCode(source: string): GCodeCommand[] {
  const lines = source.split(/\r?\n/);
  return lines.map((line, i) => parseLine(line, i));
}

/** Quick stats about a parsed program */
export interface GCodeStats {
  lineCount: number;
  rapidCount: number;
  linearCount: number;
  arcCount: number;
  toolChanges: number;
}

export function computeStats(cmds: GCodeCommand[]): GCodeStats {
  let rapidCount = 0, linearCount = 0, arcCount = 0, toolChanges = 0;
  for (const c of cmds) {
    if (c.G === 0) rapidCount++;
    else if (c.G === 1) linearCount++;
    else if (c.G === 2 || c.G === 3) arcCount++;
    if (c.T !== undefined) toolChanges++;
  }
  return { lineCount: cmds.length, rapidCount, linearCount, arcCount, toolChanges };
}
