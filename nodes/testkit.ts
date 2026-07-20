// Shared test context and independent oracles for diff-tools node unit tests.
// Not a node and not a test file (no describe/it), so it is neither registered
// as a node nor collected by jest.
import {
  AxiomContext,
  AxiomLogger,
  AxiomSecrets,
  AxiomReflection,
  AxiomMutation,
} from '../gen/axiomContext';

const reflection: AxiomReflection = {
  flow: {
    nodes: [],
    edges: [],
    loopEdges: [],
    position: { currentInstance: 0, depth: 0, loopIterations: {}, subflowStackGraphIds: [] },
    graphId: '',
  },
};

const mutation: AxiomMutation = {
  flow: {
    addNode: (_p: string, _v: string) => 0,
    addEdge: (_s: number, _d: number) => {},
  },
};

export const ctx: AxiomContext = {
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } satisfies AxiomLogger,
  secrets: { get: (_n: string): [string, boolean] => ['', false] } satisfies AxiomSecrets,
  executionId: 'test-execution-id',
  flowId: 'test-flow-id',
  tenantId: 'test-tenant-id',
  reflection,
  mutation,
};

/**
 * INDEPENDENT ORACLE — a from-scratch longest-common-subsequence dynamic
 * program. It shares no code with jsdiff and does not use its algorithm, so
 * agreement with it is evidence of correctness, not of self-consistency.
 *
 * The LCS length of two line lists is exactly the number of lines an optimal
 * diff leaves untouched — which is what Similarity.matching_lines reports — and
 * (originalLines - lcs) and (revisedLines - lcs) are exactly Stats' deleted and
 * added counts.
 */
export function lcsLength(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

/**
 * The package's line model, reimplemented here on purpose so the oracle does
 * not borrow the implementation's own splitting.
 *
 * A line CARRIES ITS TERMINATOR, so an empty text is zero lines, a trailing
 * newline closes the final line rather than starting a new one, and "keep\n" and
 * "keep" are one line each but are NOT the same line. That last point matters:
 * adding or removing a trailing newline is a real change, and every node in this
 * package must agree that it is.
 */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/**
 * A representative corpus: happy paths, boundary shapes, and the newline /
 * line-ending / Unicode edges where diff implementations actually break.
 */
export const CORPUS: Array<[string, string]> = [
  ['line1\nline2\nline3\nline4\nline5', 'line1\nline2\nCHANGED\nline4\nline5'],
  ['', ''],
  ['', 'a\nb\nc'],
  ['a\nb\nc', ''],
  ['a\nb\nc', 'a\nb\nc'],
  ['a\nb\nc', 'c\nb\na'],
  ['a\nb\nc\nd\ne', 'a\nc\ne'],
  ['x', 'y'],
  ['keep\n', 'keep'],
  ['keep', 'keep\n'],
  ['same\nsame\nsame', 'same\nsame\nsame\nsame'],
  ['one\r\ntwo\r\n', 'one\r\nTWO\r\n'],
  ['\n\n\n', '\n\n'],
  ['alpha\nbeta\ngamma\ndelta', 'beta\ngamma\ndelta\nepsilon'],
  ['tab\there', 'tab\there\nand more'],
  ['unicode: é你好\nsecond', 'unicode: é你好!\nsecond'],
  ['a\nb\nc\nd\ne\nf\ng', 'a\nX\nc\nd\nY\nf\ng'],
];
