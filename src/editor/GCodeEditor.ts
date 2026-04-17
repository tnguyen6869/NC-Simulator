// ─── G-Code Editor ────────────────────────────────────────────────────────────
// CodeMirror 6 editor with a custom G-code StreamLanguage.

import { EditorView, keymap, lineNumbers, highlightActiveLineGutter,
         highlightActiveLine, drawSelection, ViewPlugin, ViewUpdate,
         Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle, StreamLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// ── G-Code Language Definition ─────────────────────────────────────────────

const gcodeStream = StreamLanguage.define<Record<string, never>>({
  name: 'gcode',
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;

    // Line comment (;...)
    if (stream.peek() === ';') {
      stream.skipToEnd();
      return 'comment';
    }

    // Block comment (...)
    if (stream.peek() === '(') {
      stream.next();
      while (!stream.eol()) {
        if (stream.next() === ')') break;
      }
      return 'comment';
    }

    // Line numbers N (dim, not highlighted)
    if (stream.match(/^[Nn]\d+/)) return null;

    // G codes — keyword (pink/magenta)
    if (stream.match(/^[Gg]\d+(?:\.\d+)?/)) return 'keyword';

    // M codes — atom (orange)
    if (stream.match(/^[Mm]\d+(?:\.\d+)?/)) return 'atom';

    // Axis letters with value — number (purple)
    if (stream.match(/^[XYZABCxyzabc][+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/)) return 'number';

    // Arc / feed / speed params — string (green)
    if (stream.match(/^[IJKFSRijkfsr][+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/)) return 'string';

    // Tool / misc — meta (gold)
    if (stream.match(/^[THthdDpP][+-]?(?:\d+\.?\d*|\.\d+)/)) return 'meta';

    // Plain numbers
    if (stream.match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?/)) return 'number';

    stream.next();
    return null;
  },
  blankLine() { return; },
  indent() { return null; },
  languageData: {
    commentTokens: { line: ';', block: { open: '(', close: ')' } },
  },
});

// ── Highlight Style (Dracula-inspired) ─────────────────────────────────────

const gcodeHighlight = HighlightStyle.define([
  { tag: tags.keyword,   color: '#ff79c6', fontWeight: 'bold' },  // G codes
  { tag: tags.atom,      color: '#ffb86c', fontWeight: 'bold' },  // M codes
  { tag: tags.number,    color: '#bd93f9' },                      // Coordinates
  { tag: tags.string,    color: '#50fa7b' },                      // F, S, I, J, K
  { tag: tags.meta,      color: '#e3b341' },                      // T, H, D
  { tag: tags.comment,   color: '#6272a4', fontStyle: 'italic' }, // Comments
]);

// ── Active sim-line decoration ─────────────────────────────────────────────

const setSimLine = StateEffect.define<number>();

const simLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr: Transaction) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setSimLine)) {
        const lineNum = effect.value + 1; // 1-based
        if (lineNum < 1 || lineNum > tr.state.doc.lines) return Decoration.none;
        const line = tr.state.doc.line(lineNum);
        return Decoration.set([
          Decoration.line({ class: 'cm-sim-active-line' }).range(line.from),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Suppress "unused variable" — used via ViewPlugin
const _scrollPlugin = ViewPlugin.fromClass(class {
  update(_update: ViewUpdate) { /* noop */ }
});

// ─────────────────────────────────────────────────────────────────────────────

export class GCodeEditor {
  readonly view: EditorView;

  constructor(container: HTMLElement, initialContent: string = '') {
    const theme = EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
      '.cm-content': { padding: '4px 0', caretColor: 'var(--accent-cyan)' },
    });

    this.view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          history(),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          gcodeStream,
          syntaxHighlighting(gcodeHighlight),
          simLineField,
          theme,
          EditorView.lineWrapping,        // wrap long lines
          EditorState.readOnly.of(false),
        ],
      }),
    });
  }

  /** Replace the entire document content. */
  setContent(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  /** Highlight a line (0-based index) as the active simulation line. */
  highlightLine(lineIndex: number, follow: boolean): void {
    const state = this.view.state;
    const lineNum = lineIndex + 1;
    if (lineNum < 1 || lineNum > state.doc.lines) return;

    const effects: Parameters<EditorView['dispatch']>[0]['effects'] = [
      setSimLine.of(lineIndex),
    ];

    if (follow) {
      const line = state.doc.line(lineNum);
      effects.push(EditorView.scrollIntoView(line.from, { y: 'center', yMargin: 80 }));
    }

    this.view.dispatch({ effects });
  }

  /** Get the current document as a string. */
  getContent(): string {
    return this.view.state.doc.toString();
  }
}
